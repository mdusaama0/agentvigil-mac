import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isBlocklisted, extractCwdFromPath } from '../sessions/session-watcher.js';
import { isTrackableClaudeSession } from './session-utils.js';

export interface TranscriptRef {
  sessionId: string;
  filePath: string;
}

export interface TranscriptTimeline {
  firstActivity?: Date;
  lastActivity?: Date;
  stopCount: number;
}

function entryTimestamp(entry: Record<string, unknown>): Date | undefined {
  const ts = entry.timestamp ?? (entry.message as Record<string, unknown> | undefined)?.timestamp;
  if (typeof ts !== 'string') return undefined;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Stop hooks in the transcript, or 1 if the session did real work without a Stop hook. */
export function inferTaskCount(stopHooks: number, totalTokens: number): number {
  if (stopHooks > 0) return stopHooks;
  if (totalTokens > 0) return 1;
  return 0;
}

export async function parseTranscriptTimeline(
  filePath: string,
  date?: string
): Promise<TranscriptTimeline> {
  let firstActivity: Date | undefined;
  let lastActivity: Date | undefined;
  let stopCount = 0;

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    for (const line of content.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.hook_event_name === 'Stop') stopCount++;

        const d = entryTimestamp(entry);
        if (!d) continue;
        if (date && !d.toISOString().startsWith(date)) continue;

        if (!firstActivity || d < firstActivity) firstActivity = d;
        if (!lastActivity || d > lastActivity) lastActivity = d;
      } catch {
        continue;
      }
    }
  } catch {
    // unreadable transcript
  }

  return { firstActivity, lastActivity, stopCount };
}

/** Timeline scoped to a stats day, with fallbacks when lines lack timestamps. */
export async function timelineForStatsDate(
  filePath: string,
  date: string
): Promise<TranscriptTimeline> {
  const onDate = await parseTranscriptTimeline(filePath, date);
  if (onDate.firstActivity && onDate.lastActivity) return onDate;

  const full = await parseTranscriptTimeline(filePath);
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);

  if (full.firstActivity && full.lastActivity) {
    if (full.lastActivity >= dayStart && full.firstActivity <= dayEnd) {
      return {
        firstActivity: full.firstActivity < dayStart ? dayStart : full.firstActivity,
        lastActivity: full.lastActivity > dayEnd ? dayEnd : full.lastActivity,
        stopCount: full.stopCount,
      };
    }
  }

  try {
    const fileStat = await fs.stat(filePath);
    if (fileStat.mtime.toISOString().startsWith(date)) {
      return {
        firstActivity: dayStart,
        lastActivity: fileStat.mtime,
        stopCount: full.stopCount,
      };
    }
  } catch {
    // unreadable
  }

  return onDate;
}

export async function transcriptActiveOnDate(filePath: string, date: string): Promise<boolean> {
  try {
    const fileStat = await fs.stat(filePath);
    if (fileStat.mtime.toISOString().startsWith(date)) return true;

    const content = await fs.readFile(filePath, 'utf-8');
    for (const line of content.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const ts = entry.timestamp ?? entry.message?.timestamp;
        if (typeof ts === 'string' && ts.startsWith(date)) return true;
      } catch {
        continue;
      }
    }
  } catch {
    // missing or unreadable
  }

  return false;
}

/** Finds every Claude Code transcript with activity on `date` (YYYY-MM-DD). */
export async function listTranscriptsForDate(date: string): Promise<TranscriptRef[]> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const results: TranscriptRef[] = [];

  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirPath = path.join(projectsDir, entry.name);
      const files = await fs.readdir(dirPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const sessionId = file.slice(0, -'.jsonl'.length);
        if (!isTrackableClaudeSession(sessionId)) continue;

        const filePath = path.join(dirPath, file);
        const cwdGuess = extractCwdFromPath(filePath);
        if (isBlocklisted(cwdGuess)) continue;

        if (await transcriptActiveOnDate(filePath, date)) {
          results.push({ sessionId, filePath });
        }
      }
    }
  } catch {
    // projects dir missing
  }

  return results;
}
