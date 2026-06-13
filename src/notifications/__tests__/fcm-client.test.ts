import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../types.js';

const {
  existsSyncMock,
  readFileSyncMock,
  initializeAppMock,
  certMock,
  getMessagingMock,
  sendMock,
  encryptMock,
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  initializeAppMock: vi.fn(),
  certMock: vi.fn(),
  getMessagingMock: vi.fn(),
  sendMock: vi.fn(),
  encryptMock: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: { existsSync: existsSyncMock, readFileSync: readFileSyncMock },
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

vi.mock('firebase-admin/app', () => ({
  initializeApp: initializeAppMock,
  cert: certMock,
}));

vi.mock('firebase-admin/messaging', () => ({
  getMessaging: getMessagingMock,
}));

vi.mock('../../crypto/encryption.js', () => ({
  encrypt: encryptMock,
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), success: vi.fn(), info: vi.fn(), dim: vi.fn(), error: vi.fn() },
}));

const testEvent: AgentEvent = {
  type: 'permission_prompt',
  session_id: 'sess1',
  project_name: 'my-app',
  cwd: '/Users/me/my-app',
  agent: 'claude-code',
  message: 'Permission required',
  timestamp: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  encryptMock.mockReturnValue('encrypted-payload');
  initializeAppMock.mockReturnValue({ name: 'agentvigil-fcm' });
  certMock.mockReturnValue({});
  getMessagingMock.mockReturnValue({ send: sendMock });
  readFileSyncMock.mockReturnValue('{"project_id":"test"}');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendFcmEvent', () => {
  it('returns false without sending when the service account file is missing', async () => {
    existsSyncMock.mockReturnValue(false);
    vi.resetModules();
    const { sendFcmEvent } = await import('../fcm-client.js');

    const result = await sendFcmEvent('token123', testEvent, 'shared-secret');

    expect(result).toBe('error');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('encrypts the event and sends a high-priority data message when configured', async () => {
    existsSyncMock.mockReturnValue(true);
    sendMock.mockResolvedValue('message-id');
    vi.resetModules();
    const { sendFcmEvent } = await import('../fcm-client.js');

    const result = await sendFcmEvent('token123', testEvent, 'shared-secret');

    expect(result).toBe('sent');
    expect(certMock).toHaveBeenCalledWith({ project_id: 'test' });
    expect(encryptMock).toHaveBeenCalledWith(JSON.stringify(testEvent), 'shared-secret');
    expect(sendMock).toHaveBeenCalledWith({
      token: 'token123',
      data: {
        event_type: 'permission_prompt',
        payload: 'encrypted-payload',
      },
      android: {
        priority: 'high',
        ttl: 300_000,
      },
    });
  });

  it('returns "error" when the FCM send call throws', async () => {
    existsSyncMock.mockReturnValue(true);
    sendMock.mockRejectedValue(new Error('fcm down'));
    vi.resetModules();
    const { sendFcmEvent } = await import('../fcm-client.js');

    const result = await sendFcmEvent('token123', testEvent, 'shared-secret');

    expect(result).toBe('error');
  });

  it('returns "invalid-token" when FCM reports the token is unregistered', async () => {
    existsSyncMock.mockReturnValue(true);
    const err = Object.assign(new Error('Requested entity was not found.'), {
      code: 'messaging/registration-token-not-registered',
    });
    sendMock.mockRejectedValue(err);
    vi.resetModules();
    const { sendFcmEvent } = await import('../fcm-client.js');

    const result = await sendFcmEvent('token123', testEvent, 'shared-secret');

    expect(result).toBe('invalid-token');
  });
});

describe('printFcmSetupInstructions', () => {
  it('logs setup steps referencing the service account path', async () => {
    vi.resetModules();
    const { printFcmSetupInstructions, SERVICE_ACCOUNT_PATH } = await import('../fcm-client.js');
    const { logger } = await import('../../utils/logger.js');

    printFcmSetupInstructions();

    const messages = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(messages.some((m) => m.includes(SERVICE_ACCOUNT_PATH))).toBe(true);
    expect(messages.some((m) => m.includes('Firebase Console'))).toBe(true);
  });
});
