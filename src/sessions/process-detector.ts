import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isBlocklisted, extractCwdFromPath } from './session-watcher.js';
import { logger } from '../utils/logger.js';

const exec = promisify(execCb);

export interface DetectedProcess {
  pid: string;
  cwd: string;
  agentType: 'claude-code' | 'codex' | 'amp';
}

export interface SessionFile {
  sessionId: string;
  filePath: string;
  lastMessage: string;
}

/** Synchronous liveness check — sends signal 0 (no-op) to the process. */
export function isPidAlive(pid: string): boolean {
  try {
    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false;
  }
}

async function getCwdForPid(pid: string): Promise<string | null> {
  // Method 1: Claude Code writes its cwd to /tmp/claude-{pid}-cwd.
  // Trust this unconditionally — Claude itself wrote it, so even the home
  // directory is a valid project root (e.g. sessions started from ~).
  try {
    const cwdFile = `/tmp/claude-${pid}-cwd`;
    const cwd = (await fs.readFile(cwdFile, 'utf-8')).trim();
    if (cwd && cwd.length > 1 && cwd !== '/') {
      return cwd;
    }
  } catch {}

  // Method 2: lsof fallback — less authoritative, keep home-dir filter to
  // avoid noise from unrelated processes that happen to live in ~.
  try {
    const { stdout } = await exec(
      `lsof -a -p ${pid} -d cwd -Fn 2>/dev/null | grep "^n" | head -1`
    );
    const cwd = stdout.trim().replace(/^n/, '');
    if (cwd && cwd.length > 1 && cwd !== os.homedir() && cwd !== '/') {
      return cwd;
    }
  } catch {}

  return null;
}

// Use exact name match (-x) to avoid false positives from shell scripts or
// build commands that contain "claude" in their arguments.
async function findClaudePids(): Promise<string[]> {
  const pids = new Set<string>();

  try {
    const { stdout } = await exec(`pgrep -x claude 2>/dev/null || true`);
    stdout.trim().split('\n')
      .filter(p => p.trim())
      .forEach(p => pids.add(p.trim()));
  } catch {}

  for (const name of ['codex', 'amp']) {
    try {
      const { stdout } = await exec(`pgrep -x ${name} 2>/dev/null || true`);
      stdout.trim().split('\n')
        .filter(p => p.trim())
        .forEach(p => pids.add(p.trim()));
    } catch {}
  }

  return Array.from(pids).filter(p => /^\d+$/.test(p));
}

/**
 * Finds all running claude / codex / amp processes, resolves each PID's cwd
 * (preferring /tmp/claude-{pid}-cwd over lsof), and returns only processes
 * that belong to the user and are not part of the companion tool itself.
 */
export async function detectAgentProcesses(): Promise<DetectedProcess[]> {
  const rawPids = await findClaudePids();
  logger.info(`Found ${rawPids.length} claude process(es): ${rawPids.join(', ') || 'none'}`);

  if (rawPids.length === 0) return [];

  const results: DetectedProcess[] = [];

  for (const pid of rawPids) {
    try {
      const { stdout: cmdOut } = await exec(`ps -p ${pid} -o args= 2>/dev/null`);
      const fullCmd = cmdOut.trim();
      if (!fullCmd) continue;

      if (fullCmd.includes('agentvigil')) continue;

      let agentType: DetectedProcess['agentType'];
      if (fullCmd.includes('codex')) agentType = 'codex';
      else if (fullCmd.includes('amp')) agentType = 'amp';
      else agentType = 'claude-code';

      const cwd = await getCwdForPid(pid);
      if (!cwd) {
        logger.dim(`Skipping pid ${pid} — could not determine cwd`);
        continue;
      }

      try {
        await fs.access(cwd);
      } catch {
        logger.dim(`Skipping pid ${pid} — cwd does not exist: ${cwd}`);
        continue;
      }

      if (isBlocklisted(cwd)) {
        logger.dim(`Skipping pid ${pid} — blocklisted cwd: ${cwd}`);
        continue;
      }

      logger.info(`  pid ${pid}  → cwd: ${cwd}`);
      results.push({ pid, cwd, agentType });
    } catch {
      // Process died between pgrep and resolution, or insufficient permissions — skip.
      continue;
    }
  }

  return results;
}

/**
 * Given a process cwd, locates the most-recently-modified JSONL transcript
 * file that Claude Code would have written for that session.
 *
 * Claude Code encodes the project path as a directory name under
 * ~/.claude/projects/ by replacing every '/' with '-'.
 */
export async function findSessionFileForCwd(cwd: string): Promise<SessionFile | null> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  // Claude Code encodes paths by replacing all non-alphanumeric chars with '-'
  // (not just '/' — underscores and other chars are also replaced).
  const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const cwdBasename = path.basename(cwd);
  const encodedBasename = cwdBasename.replace(/[^a-zA-Z0-9]/g, '-');

  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Accept an exact encoding match or a suffix match (handles partial paths).
      if (entry.name !== encodedCwd && !entry.name.endsWith('-' + encodedBasename)) continue;

      const dirPath = path.join(projectsDir, entry.name);
      const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.jsonl'));
      if (files.length === 0) continue;

      // Pick the most recently modified transcript.
      let latest = { file: '', mtime: 0 };
      for (const f of files) {
        const stats = await fs.stat(path.join(dirPath, f));
        if (stats.mtimeMs > latest.mtime) latest = { file: f, mtime: stats.mtimeMs };
      }

      const filePath = path.join(dirPath, latest.file);
      const sessionId = path.basename(latest.file, '.jsonl');
      const lastMessage = await extractLastMessage(filePath);

      return { sessionId, filePath, lastMessage };
    }
  } catch {
    // projectsDir missing or unreadable — expected on first run
  }

  return null;
}

/**
 * Locates a session's JSONL transcript by its Claude Code session id
 * (the `{uuid}.jsonl` filename), searching all project directories.
 */
export async function findSessionFileBySessionId(sessionId: string): Promise<SessionFile | null> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const fileName = `${sessionId}.jsonl`;

  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(projectsDir, entry.name, fileName);
      try {
        await fs.access(filePath);
        const lastMessage = await extractLastMessage(filePath);
        return { sessionId, filePath, lastMessage };
      } catch {
        continue;
      }
    }
  } catch {
    // projectsDir missing or unreadable
  }

  return null;
}

/** Reads `cwd` from transcript lines, falling back to the encoded project directory name. */
export async function readCwdFromTranscript(filePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (typeof entry.cwd === 'string' && entry.cwd.length > 1) return entry.cwd;
      } catch {
        continue;
      }
    }
    return extractCwdFromPath(filePath);
  } catch {
    return undefined;
  }
}

/** Derives a display name for the stats screen from a transcript file path. */
export async function resolveProjectNameFromTranscript(filePath: string): Promise<string | undefined> {
  const cwd = await readCwdFromTranscript(filePath);
  if (cwd) {
    const name = path.basename(cwd);
    if (name && name !== '.' && name !== '/') return name;
  }

  // Encoded dir fallback: "-Users-Usama-MeetingJets" → "MeetingJets"
  const projectDir = path.basename(path.dirname(filePath));
  const segment = projectDir.split('-').filter(Boolean).at(-1);
  return segment || undefined;
}

async function extractLastMessage(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    for (const line of [...lines].reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.message && typeof parsed.message === 'string') {
          return parsed.message.substring(0, 120);
        }
      } catch { continue; }
    }
  } catch { /* unreadable */ }
  return 'Active session';
}
