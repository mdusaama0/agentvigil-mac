import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extractCwdFromPath,
  processTranscriptFile,
  readLastLine,
  type SessionUpdate,
} from '../session-watcher.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentvigil-watcher-test-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('readLastLine', () => {
  it('returns the last non-empty line of a JSONL file', async () => {
    const file = path.join(dir, 'session.jsonl');
    await fs.writeFile(file, '{"message":"first"}\n{"message":"second"}\n\n');

    expect(await readLastLine(file)).toBe('{"message":"second"}');
  });

  it('returns undefined for an empty file', async () => {
    const file = path.join(dir, 'empty.jsonl');
    await fs.writeFile(file, '');

    expect(await readLastLine(file)).toBeUndefined();
  });
});

describe('extractCwdFromPath', () => {
  it('decodes a Claude Code project directory name back into a path', () => {
    const filePath = '/Users/dev/.claude/projects/-Users-dev-myapp/abc123.jsonl';
    expect(extractCwdFromPath(filePath)).toBe('/Users/dev/myapp');
  });
});

describe('processTranscriptFile', () => {
  it('emits an update from the last entry, preferring the entry\'s own cwd', async () => {
    const file = path.join(dir, 'sess123.jsonl');
    await fs.writeFile(
      file,
      [
        JSON.stringify({ cwd: '/Users/dev/my-app', message: 'first' }),
        JSON.stringify({ cwd: '/Users/dev/my-app', message: 'latest message' }),
      ].join('\n') + '\n'
    );

    const updates: SessionUpdate[] = [];
    await processTranscriptFile(file, (u) => updates.push(u));

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      session_id: 'sess123',
      cwd: '/Users/dev/my-app',
      last_message: 'latest message',
    });
    expect(updates[0].last_activity).toBeInstanceOf(Date);
  });

  it('falls back to decoding the project directory name when the entry has no cwd', async () => {
    const projectDir = path.join(dir, '-Users-dev-myapp');
    await fs.mkdir(projectDir);
    const file = path.join(projectDir, 'sess456.jsonl');
    await fs.writeFile(file, JSON.stringify({ message: 'hello' }) + '\n');

    const updates: SessionUpdate[] = [];
    await processTranscriptFile(file, (u) => updates.push(u));

    expect(updates[0]).toMatchObject({ session_id: 'sess456', cwd: '/Users/dev/myapp', last_message: 'hello' });
  });

  it('does nothing for an empty file', async () => {
    const file = path.join(dir, 'empty.jsonl');
    await fs.writeFile(file, '');

    const updates: SessionUpdate[] = [];
    await processTranscriptFile(file, (u) => updates.push(u));

    expect(updates).toHaveLength(0);
  });

  it('silently ignores malformed JSON lines so the watcher keeps running', async () => {
    const file = path.join(dir, 'broken.jsonl');
    await fs.writeFile(file, 'not json at all\n');

    const updates: SessionUpdate[] = [];
    await expect(processTranscriptFile(file, (u) => updates.push(u))).resolves.toBeUndefined();
    expect(updates).toHaveLength(0);
  });
});
