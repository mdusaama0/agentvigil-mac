import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  inferTaskCount,
  listTranscriptsForDate,
  parseTranscriptTimeline,
  transcriptActiveOnDate,
} from '../transcript-sync.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentvigil-transcript-sync-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('inferTaskCount', () => {
  it('uses Stop hook count when present', () => {
    expect(inferTaskCount(2, 100)).toBe(2);
  });

  it('counts 1 task when work happened without a Stop hook', () => {
    expect(inferTaskCount(0, 500)).toBe(1);
  });
});

describe('parseTranscriptTimeline', () => {
  it('extracts first/last timestamps and Stop count', async () => {
    const filePath = path.join(tmpDir, 'session.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({ timestamp: '2026-06-15T10:00:00.000Z', message: { content: [] } }),
        JSON.stringify({ timestamp: '2026-06-15T11:30:00.000Z', hook_event_name: 'Stop' }),
      ].join('\n') + '\n'
    );

    const timeline = await parseTranscriptTimeline(filePath);

    expect(timeline.stopCount).toBe(1);
    expect(timeline.firstActivity?.toISOString()).toBe('2026-06-15T10:00:00.000Z');
    expect(timeline.lastActivity?.toISOString()).toBe('2026-06-15T11:30:00.000Z');
  });
});

describe('listTranscriptsForDate', () => {
  it('finds transcripts active on the requested date', async () => {
    const projectsDir = path.join(tmpDir, '.claude', 'projects', '-Users-dev-MeetingJets');
    await fs.mkdir(projectsDir, { recursive: true });
    const sessionId = '11111111-1111-4111-8111-111111111111';
    await fs.writeFile(
      path.join(projectsDir, `${sessionId}.jsonl`),
      JSON.stringify({ timestamp: '2026-06-15T12:00:00.000Z', message: { content: [] } }) + '\n'
    );

    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);

    const refs = await listTranscriptsForDate('2026-06-15');
    expect(refs).toHaveLength(1);
    expect(refs[0].sessionId).toBe(sessionId);
  });
});

describe('transcriptActiveOnDate', () => {
  it('matches by embedded timestamp even when mtime differs', async () => {
    const filePath = path.join(tmpDir, 'old-mtime.jsonl');
    await fs.writeFile(
      filePath,
      JSON.stringify({ timestamp: '2026-06-15T08:00:00.000Z' }) + '\n'
    );

    expect(await transcriptActiveOnDate(filePath, '2026-06-15')).toBe(true);
    expect(await transcriptActiveOnDate(filePath, '2026-06-14')).toBe(false);
  });
});
