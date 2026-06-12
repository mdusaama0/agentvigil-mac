import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock execFile ──────────────────────────────────────────────────────────────
type ExecCallback = (error: Error | null, stdout?: string, stderr?: string) => void;
const execFileMock = vi.fn<(command: string, args: string[], callback: ExecCallback) => void>();

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], cb: ExecCallback) => execFileMock(cmd, args, cb),
}));

// ── Mock session-manager ───────────────────────────────────────────────────────
const { getSessionMock, updateSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  updateSessionMock: vi.fn(),
}));

vi.mock('../session-manager.js', () => ({
  getSession: getSessionMock,
  updateSession: updateSessionMock,
}));

const { approvePermission, denyPermission, sendPromptToSession } =
  await import('../keystroke-injector.js');

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'sess1',
    project_name: 'my-app',
    cwd: '/Users/dev/my-app',
    agent: 'claude-code',
    state: 'blocked',
    last_activity: new Date(),
    pid: '42000',
    tmux_pane_id: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  execFileMock.mockReset();
  getSessionMock.mockReset();
  updateSessionMock.mockReset();
  getSessionMock.mockReturnValue(fakeSession());
});

// ── Missing session / pid guards ───────────────────────────────────────────────

describe('approvePermission / denyPermission guards', () => {
  it('returns false and does not shell out when session is not found', async () => {
    getSessionMock.mockReturnValue(undefined);

    expect(await approvePermission('missing')).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns false when session has no pid', async () => {
    getSessionMock.mockReturnValue(fakeSession({ pid: undefined }));

    expect(await approvePermission('sess1')).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ── Strategy 1: tmux ──────────────────────────────────────────────────────────

describe('tmux strategy', () => {
  it('sends "1" + Enter via the stored pane ID and returns true', async () => {
    getSessionMock.mockReturnValue(fakeSession({ tmux_pane_id: '%0' }));
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, '', ''));

    expect(await approvePermission('sess1')).toBe(true);

    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['send-keys', '-t', '%0', '1', 'Enter'],
      expect.any(Function)
    );
  });

  it('sends "3" + Enter via the stored pane ID and returns true', async () => {
    getSessionMock.mockReturnValue(fakeSession({ tmux_pane_id: '%1' }));
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, '', ''));

    expect(await denyPermission('sess1')).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['send-keys', '-t', '%1', '3', 'Enter'],
      expect.any(Function)
    );
  });

  it('finds the pane by pid when no pane is cached', async () => {
    getSessionMock.mockReturnValue(fakeSession({ tmux_pane_id: undefined }));
    execFileMock.mockImplementation((cmd, args, cb) => {
      if (cmd === 'which') return cb(null, '/usr/bin/tmux', '');
      if (cmd === 'tmux' && args.includes('list-panes'))
        return cb(null, '%3|42000\n%4|99999\n', '');
      if (cmd === 'tmux' && args.includes('send-keys'))
        return cb(null, '', '');
      cb(null, '', '');
    });

    expect(await approvePermission('sess1')).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['send-keys', '-t', '%3', '1', 'Enter'],
      expect.any(Function)
    );
    expect(updateSessionMock).toHaveBeenCalledWith('sess1', { tmux_pane_id: '%3' });
  });

  it('returns false (moves to next strategy) when tmux is not installed', async () => {
    getSessionMock.mockReturnValue(fakeSession({ tmux_pane_id: undefined }));
    execFileMock.mockImplementation((cmd, _args, cb) => {
      if (cmd === 'which') return cb(new Error('not found'));
      // All other commands succeed so we can see tmux-only path fails
      if (cmd === 'pgrep') return cb(null, '', '');  // no iTerm2, no Terminal
      if (cmd === 'ps') return cb(null, '??', '');   // no useful TTY → tty-write skips too
      cb(null, '', '');
    });

    // All strategies fail → fallback notification via osascript; still returns false
    expect(await approvePermission('sess1')).toBe(false);

    const tmuxSendCalls = execFileMock.mock.calls.filter(
      ([cmd, args]) => cmd === 'tmux' && (args as string[]).includes('send-keys')
    );
    expect(tmuxSendCalls).toHaveLength(0);
  });
});

// ── Strategy ordering + notification fallback ─────────────────────────────────

describe('strategy ordering and fallback', () => {
  it('fires Mac notification when all strategies fail and returns false', async () => {
    // Make every command fail except osascript (notification)
    execFileMock.mockImplementation((cmd, _args, cb) => {
      if (cmd === 'osascript') return cb(null, '', '');
      cb(new Error('unavailable'));
    });

    expect(await approvePermission('sess1')).toBe(false);

    const notifCalls = execFileMock.mock.calls.filter(
      ([cmd, args]) =>
        cmd === 'osascript' &&
        (args as string[])[1]?.includes('display notification')
    );
    expect(notifCalls.length).toBeGreaterThan(0);
  });
});

// ── sendPromptToSession ───────────────────────────────────────────────────────

describe('sendPromptToSession', () => {
  it('injects arbitrary text via tmux when a pane is known', async () => {
    getSessionMock.mockReturnValue(fakeSession({ tmux_pane_id: '%5' }));
    execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, '', ''));

    expect(await sendPromptToSession('sess1', 'run tests')).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['send-keys', '-t', '%5', 'run tests', 'Enter'],
      expect.any(Function)
    );
  });
});
