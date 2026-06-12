import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

export const SESSION_BLOCKLIST = [
  'agentvigil-mac',   // Mac companion — never a monitored session
  'node_modules',
  '.claude',
  '.agentvigil',
];

/** Returns true when the basename of `cwd` exactly matches a blocklisted tool/meta directory. */
export function isBlocklisted(cwd: string): boolean {
  const basename = path.basename(cwd).toLowerCase();
  return SESSION_BLOCKLIST.includes(basename);
}

export interface SessionUpdate {
  session_id: string;
  cwd: string;
  last_message?: string;
  last_activity: Date;
}

export async function readLastLine(filePath: string): Promise<string | undefined> {
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.at(-1);
}

// Claude Code project directory names are the cwd with '/' replaced by '-'.
// That's lossy for paths containing dashes, so this is only a fallback for
// when a transcript entry doesn't carry its own `cwd` field.
export function extractCwdFromPath(filePath: string): string {
  const projectDir = path.basename(path.dirname(filePath));
  return projectDir.replace(/-/g, '/');
}

export async function processTranscriptFile(
  filePath: string,
  onUpdate: (update: SessionUpdate) => void
): Promise<void> {
  try {
    const lastLine = await readLastLine(filePath);
    if (!lastLine) return;

    const entry = JSON.parse(lastLine);

    // Skip sessions that have already ended — they show up in the initial
    // chokidar scan but should not appear as active sessions on startup.
    const hookEvent = typeof entry.hook_event_name === 'string' ? entry.hook_event_name : '';
    if (hookEvent === 'Stop' || hookEvent === 'SubagentStop') return;
    if (typeof entry.state === 'string' && entry.state === 'done') return;

    const cwd = typeof entry.cwd === 'string' ? entry.cwd : extractCwdFromPath(filePath);
    if (isBlocklisted(cwd)) return;

    onUpdate({
      session_id: path.basename(filePath, '.jsonl'),
      cwd,
      last_message: typeof entry.message === 'string' ? entry.message : undefined,
      last_activity: new Date(),
    });
  } catch {
    // Malformed line or unreadable file — skip it, the watcher keeps running.
  }
}

/**
 * Watches JSONL transcripts for live last_message updates on existing sessions.
 * Session creation and deletion is owned by the process poller — this watcher
 * only fires on 'change' events (ignoreInitial) to keep last_message current.
 */
export function watchSessions(
  onUpdate: (update: SessionUpdate) => void
): FSWatcher {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  const watcher = chokidar.watch(`${projectsDir}/**/*.jsonl`, {
    ignoreInitial: true, // poller owns detection; watcher is supplementary only
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on('change', (filePath) => {
    void processTranscriptFile(filePath, onUpdate);
  });

  return watcher;
}
