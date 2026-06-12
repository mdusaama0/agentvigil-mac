import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../types.js';

const { FakeWebSocket, FakeWebSocketServer, wsServerInstances } = vi.hoisted(() => {
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

  class FakeWebSocket extends MiniEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 1;
    sent: string[] = [];
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
      this.emit('close');
    }
  }

  const wsServerInstances: any[] = [];
  class FakeWebSocketServer extends MiniEmitter {
    opts: any;
    closed = false;
    constructor(opts: any) {
      super();
      this.opts = opts;
      wsServerInstances.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  return { FakeWebSocket, FakeWebSocketServer, wsServerInstances };
});

vi.mock('ws', () => ({
  WebSocket: FakeWebSocket,
  WebSocketServer: FakeWebSocketServer,
}));

const { AgentVigilWsServer } = await import('../websocket-server.js');
const { generateKeyPair, deriveSharedSecret, encrypt, decrypt } = await import('../../crypto/encryption.js');

function setup(options: any = {}) {
  wsServerInstances.length = 0;
  const server = new AgentVigilWsServer(3847, options);
  server.start();
  return { server, wss: wsServerInstances.at(-1) };
}

function pairedSecrets() {
  const mac = generateKeyPair();
  const phone = generateKeyPair();
  return {
    macSecret: deriveSharedSecret(mac.secretKey, phone.publicKey),
    phoneSecret: deriveSharedSecret(phone.secretKey, mac.publicKey),
    macKeys: mac,
    phoneKeys: phone,
  };
}

const sampleEvent = () => ({
  type: 'heartbeat' as const,
  session_id: 'x',
  project_name: 'x',
  cwd: '',
  agent: 'claude-code' as const,
  message: 'x',
  timestamp: new Date().toISOString(),
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentVigilWsServer', () => {
  it('listens on the configured port', () => {
    const { wss } = setup();
    expect(wss.opts).toEqual({ port: 3847 });
  });

  it('tracks the phone connection through connect and disconnect', () => {
    const { server, wss } = setup();
    expect(server.isPhoneConnected).toBe(false);

    const ws = new FakeWebSocket();
    wss.emit('connection', ws);
    expect(server.isPhoneConnected).toBe(true);

    ws.emit('close');
    expect(server.isPhoneConnected).toBe(false);
  });

  it('sends an encrypted full_sync to the phone on connect', () => {
    const { macSecret, phoneSecret } = pairedSecrets();
    const sessions: AgentEvent[] = [
      {
        type: 'task_complete',
        session_id: 's1',
        project_name: 'app',
        cwd: '/x',
        agent: 'claude-code',
        message: 'done',
        timestamp: new Date().toISOString(),
      },
    ];
    const { server, wss } = setup({ getSessions: () => sessions });
    server.setSharedSecret(macSecret);

    const ws = new FakeWebSocket();
    wss.emit('connection', ws);

    expect(ws.sent).toHaveLength(1);
    const decrypted = JSON.parse(decrypt(JSON.parse(ws.sent[0]).payload, phoneSecret));
    expect(decrypted.type).toBe('full_sync');
    expect(decrypted.sessions).toEqual(sessions);
  });

  it('does not send events before a shared secret is established', () => {
    const { server, wss } = setup();
    const ws = new FakeWebSocket();
    wss.emit('connection', ws);
    ws.sent.length = 0;

    server.sendEvent(sampleEvent());

    expect(ws.sent).toHaveLength(0);
  });

  it('routes the unencrypted pair message to onPairRequest', () => {
    const { phoneKeys } = pairedSecrets();
    const onPairRequest = vi.fn();
    const { wss } = setup({ onPairRequest });

    const ws = new FakeWebSocket();
    wss.emit('connection', ws);
    ws.emit('message', JSON.stringify({ type: 'pair', pub_key: phoneKeys.publicKey, device_name: 'Pixel 8' }));

    expect(onPairRequest).toHaveBeenCalledWith(
      { type: 'pair', pub_key: phoneKeys.publicKey, device_name: 'Pixel 8' },
      ws
    );
  });

  it('decrypts phone commands once paired and forwards them via onCommand', () => {
    const { macSecret, phoneSecret } = pairedSecrets();
    const onCommand = vi.fn();
    const { server, wss } = setup({ onCommand });
    server.setSharedSecret(macSecret);

    const ws = new FakeWebSocket();
    wss.emit('connection', ws);

    const command = { type: 'approve', session_id: 'sess1' };
    ws.emit('message', JSON.stringify({ payload: encrypt(JSON.stringify(command), phoneSecret) }));

    expect(onCommand).toHaveBeenCalledWith(command);
  });

  it('handles full_sync_request by re-sending the session snapshot, not forwarding to onCommand', () => {
    const { macSecret, phoneSecret } = pairedSecrets();
    const onCommand = vi.fn();
    const getSessions = vi.fn().mockReturnValue([]);
    const { server, wss } = setup({ onCommand, getSessions });
    server.setSharedSecret(macSecret);

    const ws = new FakeWebSocket();
    wss.emit('connection', ws);
    const sentAfterConnect = ws.sent.length; // includes the initial full_sync

    const request = { type: 'full_sync_request', session_id: '' };
    ws.emit('message', JSON.stringify({ payload: encrypt(JSON.stringify(request), phoneSecret) }));

    // A new full_sync message was sent to the phone
    expect(ws.sent.length).toBeGreaterThan(sentAfterConnect);
    const extra = JSON.parse(decrypt(JSON.parse(ws.sent.at(-1)!).payload, phoneSecret));
    expect(extra.type).toBe('full_sync');
    // onCommand was NOT called — full_sync_request is handled at the WS layer
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('forwards hook_event messages on the /hook path bearing a valid local token to onHookEvent', () => {
    const onHookEvent = vi.fn();
    const { wss } = setup({ onHookEvent, localToken: 'mac-secret-key' });

    const ws = new FakeWebSocket();
    wss.emit('connection', ws, { url: '/hook' });
    ws.emit('message', JSON.stringify({ type: 'hook_event', token: 'mac-secret-key', event: sampleEvent() }));

    expect(onHookEvent).toHaveBeenCalledWith(sampleEvent());
  });

  it('rejects hook_event messages with a missing or wrong local token', () => {
    const onHookEvent = vi.fn();
    const { wss } = setup({ onHookEvent, localToken: 'mac-secret-key' });

    const ws = new FakeWebSocket();
    wss.emit('connection', ws, { url: '/hook' });
    ws.emit('message', JSON.stringify({ type: 'hook_event', token: 'forged-token', event: sampleEvent() }));
    ws.emit('message', JSON.stringify({ type: 'hook_event', event: sampleEvent() }));

    expect(onHookEvent).not.toHaveBeenCalled();
  });

  it('does not treat a /hook connection as the phone — no full_sync, no phoneSocket takeover', () => {
    const onHookEvent = vi.fn();
    const { server, wss } = setup({ onHookEvent, localToken: 'mac-secret-key' });

    const hookWs = new FakeWebSocket();
    wss.emit('connection', hookWs, { url: '/hook' });

    expect(server.isPhoneConnected).toBe(false);
    expect(hookWs.sent).toHaveLength(0); // no full_sync pushed to it

    hookWs.emit('message', JSON.stringify({ type: 'hook_event', token: 'mac-secret-key', event: sampleEvent() }));
    expect(onHookEvent).toHaveBeenCalledWith(sampleEvent());

    hookWs.close();
    expect(server.isPhoneConnected).toBe(false);
  });

  it('a /hook connection closing does not orphan an already-connected phone', () => {
    const onHookEvent = vi.fn();
    const { server, wss } = setup({ onHookEvent, localToken: 'mac-secret-key' });

    // Real phone connects first.
    const phoneWs = new FakeWebSocket();
    wss.emit('connection', phoneWs);
    expect(server.isPhoneConnected).toBe(true);

    // A short-lived hook-forwarding connection arrives, sends its event, and closes.
    const hookWs = new FakeWebSocket();
    wss.emit('connection', hookWs, { url: '/hook' });
    hookWs.emit('message', JSON.stringify({ type: 'hook_event', token: 'mac-secret-key', event: sampleEvent() }));
    hookWs.close();

    expect(onHookEvent).toHaveBeenCalledWith(sampleEvent());
    // The real phone connection must still be considered connected.
    expect(server.isPhoneConnected).toBe(true);
  });

  it('ignores malformed or undecryptable messages without throwing', () => {
    const onCommand = vi.fn();
    const { server, wss } = setup({ onCommand });
    server.setSharedSecret(generateKeyPair().secretKey); // valid-shaped but wrong secret

    const ws = new FakeWebSocket();
    wss.emit('connection', ws);

    expect(() => ws.emit('message', 'not json at all')).not.toThrow();
    expect(() => ws.emit('message', JSON.stringify({ payload: 'bm90LXZhbGlkLWNpcGhlcnRleHQ=' }))).not.toThrow();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('sends an encrypted heartbeat every 30 seconds while connected', () => {
    const { macSecret, phoneSecret } = pairedSecrets();
    const { server, wss } = setup();
    server.setSharedSecret(macSecret);

    const ws = new FakeWebSocket();
    wss.emit('connection', ws);
    ws.sent.length = 0;

    vi.advanceTimersByTime(30_000);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(decrypt(JSON.parse(ws.sent[0]).payload, phoneSecret)).type).toBe('heartbeat');

    vi.advanceTimersByTime(30_000);
    expect(ws.sent).toHaveLength(2);
  });

  it('skips heartbeats while no phone is connected', () => {
    const { macSecret } = pairedSecrets();
    const { server } = setup();
    server.setSharedSecret(macSecret);

    expect(() => vi.advanceTimersByTime(90_000)).not.toThrow();
    expect(server.isPhoneConnected).toBe(false);
  });

  it('stop() clears the heartbeat timer and closes the socket and server', () => {
    const { server, wss } = setup();
    const ws = new FakeWebSocket();
    wss.emit('connection', ws);
    const sentBeforeStop = ws.sent.length;

    server.stop();

    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    expect(wss.closed).toBe(true);

    vi.advanceTimersByTime(120_000);
    expect(ws.sent).toHaveLength(sentBeforeStop);
  });
});
