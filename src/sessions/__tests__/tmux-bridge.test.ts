import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecCallback = (error: Error | null, stdout?: string, stderr?: string) => void;
const execFileMock = vi.fn<(command: string, args: string[], callback: ExecCallback) => void>();

vi.mock('node:child_process', () => ({
  execFile: (command: string, args: string[], callback: ExecCallback) => execFileMock(command, args, callback),
}));

const { enumerateTmuxSessions, findTmuxPaneForSession, isPidAlive, sendMacNotification } =
  await import('../tmux-bridge.js');

beforeEach(() => {
  execFileMock.mockReset();
});

function succeedWith(stdout: string) {
  execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, stdout, ''));
}

function failWith(message: string) {
  execFileMock.mockImplementation((_cmd, _args, cb) => cb(new Error(message)));
}

describe('isPidAlive', () => {
  it('returns true for the current process (always alive)', () => {
    expect(isPidAlive(String(process.pid))).toBe(true);
  });

  it('returns false for a pid that cannot be signalled', () => {
    // PID 1 is always present but sending signal 0 to it from a non-root
    // process will throw EPERM (not ESRCH), so we use a definitely-dead PID.
    // We rely on the fact that 99999999 is astronomically unlikely to exist.
    expect(isPidAlive('99999999')).toBe(false);
  });
});

describe('enumerateTmuxSessions', () => {
  it('parses tmux panes and keeps only known agent commands', async () => {
    // Use the current process PID so isPidAlive returns true for both panes.
    const livePid = String(process.pid);
    succeedWith(
      [`%0|${livePid}|claude|/Users/dev/my-app`, `%1|${livePid}|zsh|/Users/dev/scratch`, `%2|${livePid}|codex|/Users/dev/other-app`].join(
        '\n'
      )
    );

    const panes = await enumerateTmuxSessions();

    expect(panes).toEqual([
      { pane_id: '%0', pid: livePid, command: 'claude', cwd: '/Users/dev/my-app' },
      { pane_id: '%2', pid: livePid, command: 'codex', cwd: '/Users/dev/other-app' },
    ]);
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}'],
      expect.any(Function)
    );
  });

  it('filters out panes whose pid is no longer alive', async () => {
    const livePid = String(process.pid);
    succeedWith(
      [`%0|${livePid}|claude|/Users/dev/my-app`, '%1|99999999|claude|/Users/dev/dead-app'].join('\n')
    );

    const panes = await enumerateTmuxSessions();

    expect(panes).toHaveLength(1);
    expect(panes[0].pane_id).toBe('%0');
  });

  it('returns an empty array when tmux is unavailable', async () => {
    failWith('tmux: command not found');

    expect(await enumerateTmuxSessions()).toEqual([]);
  });
});

describe('findTmuxPaneForSession', () => {
  const panes = [
    { pane_id: '%0', pid: '1', command: 'claude', cwd: '/Users/dev/my-app' },
    { pane_id: '%1', pid: '2', command: 'claude', cwd: '/Users/dev/my-app/packages/api' },
  ];

  it('matches an exact cwd', () => {
    expect(findTmuxPaneForSession('/Users/dev/my-app', panes)?.pane_id).toBe('%0');
  });

  it('matches the pane whose cwd prefixes a nested session cwd', () => {
    expect(findTmuxPaneForSession('/Users/dev/my-app/packages/api/src', panes)?.pane_id).toBe('%1');
  });

  it('returns undefined when no pane matches', () => {
    expect(findTmuxPaneForSession('/Users/dev/unrelated', panes)).toBeUndefined();
  });
});

describe('sendMacNotification', () => {
  it('shells out to osascript with an escaped display-notification script', async () => {
    succeedWith('');

    await sendMacNotification('Title "with quotes"', 'back\\slash');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [command, args] = execFileMock.mock.calls[0];
    expect(command).toBe('osascript');
    expect(args[0]).toBe('-e');
    expect(args[1]).toContain('display notification');
    expect(args[1]).toContain('\\"with quotes\\"');
    expect(args[1]).toContain('back\\\\slash');
  });

  it('catches and logs when osascript fails, without throwing', async () => {
    failWith('no display present');

    await expect(sendMacNotification('t', 'm')).resolves.toBeUndefined();
  });
});

