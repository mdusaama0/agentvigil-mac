import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- FakeChildProcess is used as a type below
const { FakeChildProcess, spawnMock } = vi.hoisted(() => {
  class MiniEmitter {
    private listeners = new Map<string, Array<(...args: any[]) => void>>();
    on(event: string, fn: (...args: any[]) => void) {
      const arr = this.listeners.get(event) ?? [];
      arr.push(fn);
      this.listeners.set(event, arr);
      return this;
    }
    emit(event: string, ...args: any[]) {
      for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args);
    }
  }

  class FakeChildProcess extends MiniEmitter {
    stderr = new MiniEmitter();
    stdout = new MiniEmitter();
    killed = false;
    kill = function (this: FakeChildProcess) {
      this.killed = true;
    };
  }

  const spawnMock = vi.fn(() => new FakeChildProcess());

  return { FakeChildProcess, spawnMock };
});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

const { TunnelManager } = await import('../tunnel-manager.js');

function latestProcess(): InstanceType<typeof FakeChildProcess> {
  return spawnMock.mock.results.at(-1)!.value;
}

beforeEach(() => {
  spawnMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TunnelManager.start', () => {
  it('spawns cloudflared with the expected arguments', () => {
    const manager = new TunnelManager();
    void manager.start(3847);

    expect(spawnMock).toHaveBeenCalledWith('cloudflared', [
      'tunnel',
      '--url',
      'http://localhost:3847',
      '--no-autoupdate',
      '--logfile',
      '/dev/null',
    ]);
  });

  it('resolves with the wss:// URL parsed from stderr output', async () => {
    const manager = new TunnelManager();
    const startPromise = manager.start(3847);

    latestProcess().stderr.emit(
      'data',
      Buffer.from('Your quick Tunnel has been created! Visit it at: https://abc123.trycloudflare.com\n')
    );

    await expect(startPromise).resolves.toBe('wss://abc123.trycloudflare.com');
    expect(manager.getTunnelUrl()).toBe('wss://abc123.trycloudflare.com');
  });

  it('rejects if cloudflared exits before producing a URL', async () => {
    const manager = new TunnelManager();
    const startPromise = manager.start(3847);

    latestProcess().emit('exit', 1);

    await expect(startPromise).rejects.toThrow(/exited with code 1/);
  });

  it('rejects when the process errors out (e.g. binary not installed)', async () => {
    const manager = new TunnelManager();
    const startPromise = manager.start(3847);

    latestProcess().emit('error', new Error('spawn cloudflared ENOENT'));

    await expect(startPromise).rejects.toThrow(/ENOENT/);
  });

  it('rejects if no tunnel URL appears within 30 seconds', async () => {
    vi.useFakeTimers();
    const manager = new TunnelManager();
    const startPromise = manager.start(3847);
    const expectation = expect(startPromise).rejects.toThrow(/within 30s/);

    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
  });

  it('ignores further exit/error events once a URL has already resolved it', async () => {
    const manager = new TunnelManager();
    const startPromise = manager.start(3847);
    const proc = latestProcess();

    proc.stderr.emit('data', Buffer.from('https://abc123.trycloudflare.com'));
    await startPromise;

    expect(() => proc.emit('exit', 1)).not.toThrow();
    expect(manager.getTunnelUrl()).toBe('wss://abc123.trycloudflare.com');
  });
});

describe('TunnelManager.stop', () => {
  it('kills the cloudflared process and resets the tunnel URL', async () => {
    const manager = new TunnelManager();
    const startPromise = manager.start(3847);
    const proc = latestProcess();
    proc.stderr.emit('data', Buffer.from('https://abc123.trycloudflare.com'));
    await startPromise;

    manager.stop();

    expect(proc.killed).toBe(true);
    expect(manager.getTunnelUrl()).toBeNull();
  });
});
