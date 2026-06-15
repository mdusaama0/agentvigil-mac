import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ── Mock child_process.exec ────────────────────────────────────────────────
// process-detector uses promisify(exec), so we mock the underlying exec.
type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;
const execMock = vi.fn<(command: string, callback: ExecCallback) => void>();

vi.mock('node:child_process', () => ({
  exec: (cmd: string, cb: ExecCallback) => execMock(cmd, cb),
}));

const { detectAgentProcesses, findSessionFileForCwd, findSessionFileBySessionId, resolveProjectNameFromTranscript, isPidAlive } =
  await import('../process-detector.js');

// ── Helpers ────────────────────────────────────────────────────────────────

function execFails(): void {
  execMock.mockImplementation((_cmd, cb) => cb(new Error('command failed')));
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-test-'));
  execMock.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── isPidAlive ─────────────────────────────────────────────────────────────

describe('isPidAlive', () => {
  it('returns true for the current process', () => {
    expect(isPidAlive(String(process.pid))).toBe(true);
  });

  it('returns false for a pid that does not exist', () => {
    expect(isPidAlive('99999999')).toBe(false);
  });
});

// ── detectAgentProcesses ───────────────────────────────────────────────────

describe('detectAgentProcesses', () => {
  it('returns an empty array when pgrep finds no matches', async () => {
    execMock.mockImplementation((_cmd, cb) => cb(null, { stdout: '', stderr: '' }));
    expect(await detectAgentProcesses()).toEqual([]);
  });

  it('returns an empty array when exec throws', async () => {
    execFails();
    expect(await detectAgentProcesses()).toEqual([]);
  });

  it('parses a claude process and resolves its cwd', async () => {
    const fakePid = '12345';
    execMock.mockImplementation((cmd, cb) => {
      if (cmd.includes('pgrep'))    return cb(null, { stdout: fakePid, stderr: '' });
      if (cmd.includes('ps') && cmd.includes(fakePid)) return cb(null, { stdout: '/usr/local/bin/claude --dangerously-skip-permissions', stderr: '' });
      if (cmd.includes('lsof') && cmd.includes(fakePid)) return cb(null, { stdout: `n${tmpDir}`, stderr: '' });
      cb(null, { stdout: '', stderr: '' });
    });

    const result = await detectAgentProcesses();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      pid: fakePid,
      cwd: tmpDir,
      agentType: 'claude-code',
    });
  });

  it('detects codex and amp agent types correctly', async () => {
    // Use two real subdirs under tmpDir so fs.access() passes
    const projA = path.join(tmpDir, 'proj-a');
    const projB = path.join(tmpDir, 'proj-b');
    await fs.mkdir(projA);
    await fs.mkdir(projB);

    execMock.mockImplementation((cmd, cb) => {
      if (cmd.includes('pgrep')) return cb(null, { stdout: '111\n222', stderr: '' });
      if (cmd.includes('ps') && cmd.includes('111')) return cb(null, { stdout: '/usr/bin/codex run', stderr: '' });
      if (cmd.includes('ps') && cmd.includes('222')) return cb(null, { stdout: '/usr/bin/amp run', stderr: '' });
      if (cmd.includes('lsof') && cmd.includes('111')) return cb(null, { stdout: `n${projA}`, stderr: '' });
      if (cmd.includes('lsof') && cmd.includes('222')) return cb(null, { stdout: `n${projB}`, stderr: '' });
      cb(null, { stdout: '', stderr: '' });
    });

    const result = await detectAgentProcesses();

    expect(result.find(p => p.pid === '111')?.agentType).toBe('codex');
    expect(result.find(p => p.pid === '222')?.agentType).toBe('amp');
  });

  it('skips processes that contain agentvigil in the command', async () => {
    execMock.mockImplementation((cmd, cb) => {
      if (cmd.includes('pgrep')) return cb(null, { stdout: '999', stderr: '' });
      if (cmd.includes('ps'))    return cb(null, { stdout: 'node /Users/dev/agentvigil-mac/dist/index.js claude', stderr: '' });
      cb(null, { stdout: '', stderr: '' });
    });

    expect(await detectAgentProcesses()).toEqual([]);
  });

  it('skips processes where lsof returns an empty cwd', async () => {
    execMock.mockImplementation((cmd, cb) => {
      if (cmd.includes('pgrep')) return cb(null, { stdout: '555', stderr: '' });
      if (cmd.includes('ps'))    return cb(null, { stdout: '/usr/local/bin/claude', stderr: '' });
      if (cmd.includes('lsof')) return cb(null, { stdout: '', stderr: '' });
      cb(null, { stdout: '', stderr: '' });
    });

    expect(await detectAgentProcesses()).toEqual([]);
  });

  it('skips processes from blocklisted directories', async () => {
    execMock.mockImplementation((cmd, cb) => {
      if (cmd.includes('pgrep')) return cb(null, { stdout: '777', stderr: '' });
      if (cmd.includes('ps'))    return cb(null, { stdout: '/usr/local/bin/claude', stderr: '' });
      if (cmd.includes('lsof')) return cb(null, { stdout: 'n/Users/dev/agentvigil-mac', stderr: '' });
      cb(null, { stdout: '', stderr: '' });
    });

    expect(await detectAgentProcesses()).toEqual([]);
  });
});

// ── findSessionFileForCwd ──────────────────────────────────────────────────

describe('findSessionFileForCwd', () => {
  it('returns null when the projects directory does not exist', async () => {
    // tmpDir has no .claude/projects subdir
    const result = await findSessionFileForCwd('/totally/missing/project');
    expect(result).toBeNull();
  });

  it('finds the most-recently-modified jsonl file for a matching project dir', async () => {
    // Build a fake ~/.claude/projects layout inside tmpDir
    const projectsDir = path.join(tmpDir, '.claude', 'projects');
    const projectDir  = path.join(projectsDir, '-Users-dev-my-app');
    await fs.mkdir(projectDir, { recursive: true });

    const session1 = path.join(projectDir, 'aaaa1111.jsonl');
    const session2 = path.join(projectDir, 'bbbb2222.jsonl');
    await fs.writeFile(session1, '{"message":"old message"}\n');
    // Ensure session2 has a newer mtime by waiting a tick.
    await new Promise(r => setTimeout(r, 10));
    await fs.writeFile(session2, '{"message":"latest message"}\n');

    // Monkey-patch os.homedir for this call — re-import with mocked homedir.
    const origHomedir = os.homedir;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);

    const result = await findSessionFileForCwd('/Users/dev/my-app');

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('bbbb2222');
    expect(result!.lastMessage).toBe('latest message');

    vi.spyOn(os, 'homedir').mockReturnValue(origHomedir());
  });

  it('returns null when the project directory has no jsonl files', async () => {
    const projectsDir = path.join(tmpDir, '.claude', 'projects');
    await fs.mkdir(path.join(projectsDir, '-Users-dev-empty'), { recursive: true });

    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    const result = await findSessionFileForCwd('/Users/dev/empty');
    expect(result).toBeNull();
    vi.restoreAllMocks();
  });
});

describe('findSessionFileBySessionId', () => {
  it('finds a transcript by session id across project directories', async () => {
    const projectsDir = path.join(tmpDir, '.claude', 'projects');
    const projectDir = path.join(projectsDir, '-Users-Usama-MeetingJets');
    await fs.mkdir(projectDir, { recursive: true });
    const sessionId = 'eb369977-e06e-4cfc-86cb-c12625f2b97d';
    await fs.writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      '{"message":"hello"}\n'
    );

    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    const result = await findSessionFileBySessionId(sessionId);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(sessionId);
    expect(result!.lastMessage).toBe('hello');
    vi.restoreAllMocks();
  });
});

describe('resolveProjectNameFromTranscript', () => {
  it('uses cwd from the transcript when present', async () => {
    const filePath = path.join(tmpDir, 'session.jsonl');
    await fs.writeFile(
      filePath,
      JSON.stringify({ cwd: '/Users/dev/MeetingJets', message: 'hi' }) + '\n'
    );

    await expect(resolveProjectNameFromTranscript(filePath)).resolves.toBe('MeetingJets');
  });

  it('falls back to the encoded project directory name', async () => {
    const filePath = path.join(tmpDir, '-Users-Usama-MeetingJets', 'session.jsonl');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{"message":"hi"}\n');

    await expect(resolveProjectNameFromTranscript(filePath)).resolves.toBe('MeetingJets');
  });
});
