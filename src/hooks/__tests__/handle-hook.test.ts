import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../types.js';

const { FakeWebSocket, wsInstances, getConfigMock, loadOrCreateKeyPairMock, handleAgentEventMock, relayCtorMock } =
  vi.hoisted(() => {
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

    const wsInstances: any[] = [];

    class FakeWebSocket extends MiniEmitter {
      static nextBehavior: 'open' | 'error' = 'open';
      url: string;
      sent: string[] = [];
      terminated = false;
      closed = false;

      constructor(url: string) {
        super();
        this.url = url;
        wsInstances.push(this);
        const behavior = FakeWebSocket.nextBehavior;
        queueMicrotask(() => this.emit(behavior === 'open' ? 'open' : 'error', new Error('ECONNREFUSED')));
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.closed = true;
        this.emit('close');
      }
      terminate() {
        this.terminated = true;
      }
    }

    const getConfigMock = vi.fn();
    const loadOrCreateKeyPairMock = vi.fn();
    const handleAgentEventMock = vi.fn().mockResolvedValue(undefined);
    const relayCtorMock = vi.fn();

    return {
      FakeWebSocket,
      wsInstances,
      getConfigMock,
      loadOrCreateKeyPairMock,
      handleAgentEventMock,
      relayCtorMock,
    };
  });

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));

vi.mock('../../utils/config.js', () => ({ getConfig: getConfigMock }));

vi.mock('../../crypto/encryption.js', () => ({ loadOrCreateKeyPair: loadOrCreateKeyPairMock }));

vi.mock('../../relay/relay-handler.js', () => ({
  RelayHandler: class {
    constructor(...args: any[]) {
      relayCtorMock(...args);
    }
    handleAgentEvent(event: AgentEvent) {
      return handleAgentEventMock(event);
    }
  },
}));

const { handleHook } = await import('../hook-handler.js');

function writeStdin(payload: object) {
  process.nextTick(() => {
    process.stdin.emit('data', JSON.stringify(payload));
    process.stdin.emit('end');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  wsInstances.length = 0;
  FakeWebSocket.nextBehavior = 'open';
  getConfigMock.mockResolvedValue({ ntfy_topic: 'agentvigil-topic', ws_port: 3847 });
  loadOrCreateKeyPairMock.mockResolvedValue({ publicKey: 'pub', secretKey: 'mac-secret-key' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleHook', () => {
  it('relays the built event through RelayHandler for the ntfy safety-net push when the daemon is unreachable', async () => {
    FakeWebSocket.nextBehavior = 'error';
    writeStdin({
      session_id: 'sess1',
      transcript_path: '/x/sess1.jsonl',
      cwd: '/Users/dev/my-app',
      hook_event_name: 'Stop',
    });

    await handleHook('stop');

    expect(relayCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ isPhoneConnected: false }),
      'agentvigil-topic'
    );
    expect(handleAgentEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_ended', session_id: 'sess1', project_name: 'my-app' })
    );
  });

  it('does not run the local relay when the daemon is reachable (avoids duplicate notifications)', async () => {
    writeStdin({
      session_id: 'sess1',
      transcript_path: '/x/sess1.jsonl',
      cwd: '/Users/dev/my-app',
      hook_event_name: 'Stop',
    });

    await handleHook('stop');

    expect(relayCtorMock).not.toHaveBeenCalled();
    expect(handleAgentEventMock).not.toHaveBeenCalled();
  });

  it('skips everything for SubagentStop — never relays, forwards, or notifies', async () => {
    writeStdin({
      session_id: 'sess1',
      transcript_path: '/x/sess1.jsonl',
      cwd: '/Users/dev/my-app',
      hook_event_name: 'SubagentStop',
    });

    await handleHook('subagent_stop');

    expect(wsInstances).toHaveLength(0);
    expect(relayCtorMock).not.toHaveBeenCalled();
    expect(handleAgentEventMock).not.toHaveBeenCalled();
  });

  it('forwards the event to the daemon over a local WebSocket with the local token', async () => {
    writeStdin({
      session_id: 'sess1',
      transcript_path: '/x/sess1.jsonl',
      cwd: '/Users/dev/my-app',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Run rm -rf?',
    });

    await handleHook('permission_prompt');

    expect(wsInstances).toHaveLength(1);
    expect(wsInstances[0].url).toBe('ws://127.0.0.1:3847/hook');
    const sent = JSON.parse(wsInstances[0].sent[0]);
    expect(sent.type).toBe('hook_event');
    expect(sent.token).toBe('mac-secret-key');
    expect(sent.event).toMatchObject({ type: 'permission_prompt', session_id: 'sess1', permission_command: 'Run rm -rf?' });
  });

  it('does not throw when the daemon is not running (connection error)', async () => {
    FakeWebSocket.nextBehavior = 'error';
    writeStdin({
      session_id: 'sess1',
      transcript_path: '/x/sess1.jsonl',
      cwd: '/Users/dev/my-app',
      hook_event_name: 'Stop',
    });

    await expect(handleHook('stop')).resolves.toBeUndefined();
  });
});
