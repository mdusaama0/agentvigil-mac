import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../types.js';

const {
  getSessionMock,
  getSessionByCwdMock,
  updateSessionMock,
  deleteSessionMock,
  approvePermissionMock,
  denyPermissionMock,
  sendPromptToSessionMock,
  sendPermissionNotificationMock,
  sendTaskCompleteNotificationMock,
  sendErrorNotificationMock,
  sendIdleNotificationMock,
  sendFcmEventMock,
  getConfigMock,
  saveConfigMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionByCwdMock: vi.fn(),
  updateSessionMock: vi.fn(),
  deleteSessionMock: vi.fn(),
  approvePermissionMock: vi.fn(),
  denyPermissionMock: vi.fn(),
  sendPromptToSessionMock: vi.fn(),
  sendPermissionNotificationMock: vi.fn(),
  sendTaskCompleteNotificationMock: vi.fn(),
  sendErrorNotificationMock: vi.fn(),
  sendIdleNotificationMock: vi.fn(),
  sendFcmEventMock: vi.fn(),
  getConfigMock: vi.fn(),
  saveConfigMock: vi.fn(),
}));

vi.mock('../../sessions/session-manager.js', () => ({
  getSession: getSessionMock,
  getSessionByCwd: getSessionByCwdMock,
  updateSession: updateSessionMock,
  deleteSession: deleteSessionMock,
}));

vi.mock('../../sessions/keystroke-injector.js', () => ({
  approvePermission: approvePermissionMock,
  denyPermission: denyPermissionMock,
  sendPromptToSession: sendPromptToSessionMock,
}));

vi.mock('../../notifications/ntfy-client.js', () => ({
  sendPermissionNotification: sendPermissionNotificationMock,
  sendTaskCompleteNotification: sendTaskCompleteNotificationMock,
  sendErrorNotification: sendErrorNotificationMock,
  sendIdleNotification: sendIdleNotificationMock,
}));

vi.mock('../../notifications/fcm-client.js', () => ({
  sendFcmEvent: sendFcmEventMock,
}));

vi.mock('../../utils/config.js', () => ({
  getConfig: getConfigMock,
  saveConfig: saveConfigMock,
}));

const { RelayHandler } = await import('../relay-handler.js');

function fakeWsServer(connected: boolean, sharedSecret?: string) {
  return {
    sendEvent: vi.fn(),
    get isPhoneConnected() {
      return connected;
    },
    getSharedSecret: vi.fn(() => sharedSecret),
  };
}

function event(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: 'task_complete',
    session_id: 'sess1',
    project_name: 'my-app',
    cwd: '/Users/me/my-app',
    agent: 'claude-code',
    message: 'Session completed',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockReturnValue(undefined);
  getSessionByCwdMock.mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RelayHandler.handleAgentEvent', () => {
  it('updates the session store with details from the event', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await handler.handleAgentEvent(
      event({ type: 'permission_prompt', message: 'Run rm -rf?', permission_command: 'rm -rf /tmp' })
    );

    expect(updateSessionMock).toHaveBeenCalledWith(
      'sess1',
      expect.objectContaining({
        state: 'blocked',
        project_name: 'my-app',
        cwd: '/Users/me/my-app',
        agent: 'claude-code',
        last_message: 'Run rm -rf?',
      })
    );
  });

  it('passes permission_command through to the session store on permission_prompt', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await handler.handleAgentEvent(
      event({ type: 'permission_prompt', message: 'Run rm -rf?', permission_command: 'rm -rf /tmp' })
    );

    expect(updateSessionMock).toHaveBeenCalledWith(
      'sess1',
      expect.objectContaining({ permission_command: 'rm -rf /tmp' })
    );
  });

  it('merges a poller-created session for the same cwd into the new session_id (carrying over pid)', async () => {
    getSessionByCwdMock.mockReturnValue({
      session_id: 'poller-id',
      cwd: '/Users/me/my-app',
      project_name: 'my-app',
      agent: 'claude-code',
      state: 'working',
      last_activity: new Date(),
      pid: '74878',
      tmux_pane_id: '%3',
    });

    const ws = fakeWsServer(true);
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleAgentEvent(
      event({ type: 'permission_prompt', session_id: 'sess1', message: 'Run rm -rf?', permission_command: 'rm -rf /tmp' })
    );

    // Seeds the new id with the stale entry's pid/tmux info before the
    // normal updateSession call applies the rest of the event.
    expect(updateSessionMock).toHaveBeenCalledWith('sess1', { pid: '74878', tmux_pane_id: '%3' });
    expect(deleteSessionMock).toHaveBeenCalledWith('poller-id');
    expect(ws.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_ended', session_id: 'poller-id' })
    );
    expect(ws.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'permission_prompt', session_id: 'sess1' })
    );
  });

  it('does not reconcile when no other session shares the cwd', async () => {
    const ws = fakeWsServer(true);
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'permission_prompt', session_id: 'sess1' }));

    expect(deleteSessionMock).not.toHaveBeenCalled();
    expect(ws.sendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session_ended' }));
  });

  it('does not reconcile when the session_id already exists in the store', async () => {
    getSessionMock.mockReturnValue({
      session_id: 'sess1',
      cwd: '/Users/me/my-app',
      project_name: 'my-app',
      agent: 'claude-code',
      state: 'working',
      last_activity: new Date(),
    });
    getSessionByCwdMock.mockReturnValue({
      session_id: 'poller-id',
      cwd: '/Users/me/my-app',
      project_name: 'my-app',
      agent: 'claude-code',
      state: 'working',
      last_activity: new Date(),
      pid: '74878',
    });

    const handler = new RelayHandler(fakeWsServer(true), 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'permission_prompt', session_id: 'sess1' }));

    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it.each([
    ['permission_prompt', 'blocked'],
    ['task_complete', 'done'],
    ['session_error', 'error'],
    ['idle_waiting', 'idle'],
    ['session_started', 'working'],
    ['session_ended', 'done'],
  ] as const)('maps %s events to session state %s', async (type, state) => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type }));

    expect(updateSessionMock).toHaveBeenCalledWith('sess1', expect.objectContaining({ state }));
  });

  it('does not touch the session store for heartbeat/full_sync events', async () => {
    const handler = new RelayHandler(fakeWsServer(true), 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'heartbeat' }));
    await handler.handleAgentEvent(event({ type: 'full_sync' }));

    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('forwards the event over the WebSocket only when the phone is connected', async () => {
    const connectedWs = fakeWsServer(true);
    const disconnectedWs = fakeWsServer(false);

    await new RelayHandler(connectedWs, 'agentvigil-topic').handleAgentEvent(event());
    await new RelayHandler(disconnectedWs, 'agentvigil-topic').handleAgentEvent(event());

    expect(connectedWs.sendEvent).toHaveBeenCalledTimes(1);
    expect(disconnectedWs.sendEvent).not.toHaveBeenCalled();
  });

  it('always sends an ntfy push, even when the phone is connected via WS', async () => {
    const handler = new RelayHandler(fakeWsServer(true), 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'session_error', message: 'Process crashed' }));

    expect(sendErrorNotificationMock).toHaveBeenCalledWith('agentvigil-topic', 'my-app', 'Process crashed');
  });

  it('routes permission_prompt to sendPermissionNotification with the command text', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await handler.handleAgentEvent(
      event({ type: 'permission_prompt', permission_command: 'rm -rf /tmp/x', message: 'Permission required' })
    );

    expect(sendPermissionNotificationMock).toHaveBeenCalledWith('agentvigil-topic', 'my-app', 'rm -rf /tmp/x', 'sess1');
  });

  it('routes idle_waiting to sendIdleNotification', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'idle_waiting' }));

    expect(sendIdleNotificationMock).toHaveBeenCalledWith('agentvigil-topic', 'my-app', 'sess1');
  });

  it('routes task_complete to sendTaskCompleteNotification with a duration derived from prior activity', async () => {
    getSessionMock.mockReturnValue({
      session_id: 'sess1',
      cwd: '/Users/me/my-app',
      project_name: 'my-app',
      agent: 'claude-code',
      state: 'working',
      last_activity: new Date(Date.now() - 65_000),
    });

    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'task_complete' }));

    expect(sendTaskCompleteNotificationMock).toHaveBeenCalledWith(
      'agentvigil-topic',
      'my-app',
      expect.stringMatching(/^1m\d+s$/)
    );
  });

  it('does not send any ntfy push for heartbeat/full_sync events', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'heartbeat' }));
    await handler.handleAgentEvent(event({ type: 'full_sync' }));

    expect(sendPermissionNotificationMock).not.toHaveBeenCalled();
    expect(sendTaskCompleteNotificationMock).not.toHaveBeenCalled();
    expect(sendErrorNotificationMock).not.toHaveBeenCalled();
    expect(sendIdleNotificationMock).not.toHaveBeenCalled();
  });

  it('removes the session from the store after a session_ended event', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'session_ended' }));

    expect(deleteSessionMock).toHaveBeenCalledWith('sess1');
  });

  it('sends a Task Complete ntfy push on session_ended (no separate Session Ended notification)', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'session_ended' }));

    expect(sendTaskCompleteNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('only sends one Task Complete notification per session within the dedup window', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');

    await handler.handleAgentEvent(event({ type: 'task_complete', session_id: 'sess1' }));
    await handler.handleAgentEvent(event({ type: 'session_ended', session_id: 'sess1' }));

    expect(sendTaskCompleteNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('sends separate Task Complete notifications for different sessions', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');

    await handler.handleAgentEvent(event({ type: 'task_complete', session_id: 'sess1' }));
    await handler.handleAgentEvent(event({ type: 'task_complete', session_id: 'sess2' }));

    expect(sendTaskCompleteNotificationMock).toHaveBeenCalledTimes(2);
  });

  it('ignores a session_ended event entirely when the session is currently blocked on a permission prompt', async () => {
    getSessionMock.mockReturnValue({
      session_id: 'sess1',
      cwd: '/Users/me/my-app',
      project_name: 'my-app',
      agent: 'claude-code',
      state: 'blocked',
      last_activity: new Date(),
    });

    const ws = fakeWsServer(true);
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'session_ended' }));

    expect(updateSessionMock).not.toHaveBeenCalled();
    expect(ws.sendEvent).not.toHaveBeenCalled();
    expect(sendTaskCompleteNotificationMock).not.toHaveBeenCalled();
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it('processes a session_ended event normally when it arrives well after a permission prompt (user approved in the Mac terminal)', async () => {
    const longBlocked = {
      session_id: 'sess1',
      cwd: '/Users/me/my-app',
      project_name: 'my-app',
      agent: 'claude-code',
      state: 'blocked',
      last_activity: new Date(Date.now() - 10_000),
    } as const;
    const done = { ...longBlocked, state: 'done' } as const;

    getSessionMock
      .mockReturnValueOnce(longBlocked) // `previous` — outside the spurious-Stop window
      .mockReturnValueOnce(longBlocked) // reconcileDuplicateSession — already exists, no merge
      .mockReturnValueOnce(done); // final check before deleteSession — no longer blocked

    const ws = fakeWsServer(true);
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'session_ended' }));

    expect(updateSessionMock).toHaveBeenCalledWith('sess1', expect.objectContaining({ state: 'done' }));
    expect(ws.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'session_ended' }));
    expect(deleteSessionMock).toHaveBeenCalledWith('sess1');
  });

  it('does not delete the session if a permission_prompt re-blocked it while the ntfy push was in flight', async () => {
    // 1st call (entry `previous`): not blocked yet, so the spurious-Stop
    // guard doesn't fire. 2nd call (inside reconcileDuplicateSession): the
    // session already exists under this id, so no merge is attempted. 3rd
    // call (re-check before deleteSession): a concurrent permission_prompt
    // has set it back to 'blocked'.
    const working = {
      session_id: 'sess1',
      cwd: '/Users/me/my-app',
      project_name: 'my-app',
      agent: 'claude-code',
      state: 'working',
      last_activity: new Date(),
    } as const;
    const blocked = { ...working, state: 'blocked' } as const;

    getSessionMock
      .mockReturnValueOnce(working)
      .mockReturnValueOnce(working)
      .mockReturnValueOnce(blocked);

    const ws = fakeWsServer(true);
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'session_ended' }));

    expect(ws.sendEvent).toHaveBeenCalledTimes(1);
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it('does not delete the session for other event types', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'task_complete' }));

    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it('never throws even when the WebSocket send fails', async () => {
    const ws = fakeWsServer(true);
    ws.sendEvent.mockImplementation(() => {
      throw new Error('socket gone');
    });

    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await expect(handler.handleAgentEvent(event())).resolves.toBeUndefined();
  });
});

describe('RelayHandler FCM push routing', () => {
  it('sends permission_prompt via FCM and skips ntfy when a token + shared secret are configured', async () => {
    getConfigMock.mockResolvedValue({ fcm_token: 'token123' });
    sendFcmEventMock.mockResolvedValue('sent');

    const ws = fakeWsServer(false, 'shared-secret');
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleAgentEvent(
      event({ type: 'permission_prompt', permission_command: 'rm -rf /tmp/x' })
    );

    expect(sendFcmEventMock).toHaveBeenCalledWith(
      'token123',
      expect.objectContaining({ type: 'permission_prompt' }),
      'shared-secret'
    );
    expect(sendPermissionNotificationMock).not.toHaveBeenCalled();
  });

  it('falls back to ntfy when the FCM send fails', async () => {
    getConfigMock.mockResolvedValue({ fcm_token: 'token123' });
    sendFcmEventMock.mockResolvedValue('error');

    const ws = fakeWsServer(false, 'shared-secret');
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleAgentEvent(
      event({ type: 'permission_prompt', permission_command: 'rm -rf /tmp/x' })
    );

    expect(sendFcmEventMock).toHaveBeenCalled();
    expect(sendPermissionNotificationMock).toHaveBeenCalledWith('agentvigil-topic', 'my-app', 'rm -rf /tmp/x', 'sess1');
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it('clears the stored FCM token when it is permanently unregistered', async () => {
    const config = { fcm_token: 'token123' };
    getConfigMock.mockResolvedValue(config);
    sendFcmEventMock.mockResolvedValue('invalid-token');

    const ws = fakeWsServer(false, 'shared-secret');
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleAgentEvent(
      event({ type: 'permission_prompt', permission_command: 'rm -rf /tmp/x' })
    );

    expect(sendPermissionNotificationMock).toHaveBeenCalledWith('agentvigil-topic', 'my-app', 'rm -rf /tmp/x', 'sess1');
    expect(saveConfigMock).toHaveBeenCalledWith(expect.objectContaining({ fcm_token: undefined }));
  });

  it('falls back to ntfy without attempting FCM when no token is configured', async () => {
    getConfigMock.mockResolvedValue({ fcm_token: undefined });

    const ws = fakeWsServer(false, 'shared-secret');
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'idle_waiting' }));

    expect(sendFcmEventMock).not.toHaveBeenCalled();
    expect(sendIdleNotificationMock).toHaveBeenCalledWith('agentvigil-topic', 'my-app', 'sess1');
  });

  it('does not attempt FCM when there is no shared secret (not yet paired)', async () => {
    const ws = fakeWsServer(false);
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleAgentEvent(event({ type: 'task_complete' }));

    expect(getConfigMock).not.toHaveBeenCalled();
    expect(sendFcmEventMock).not.toHaveBeenCalled();
    expect(sendTaskCompleteNotificationMock).toHaveBeenCalled();
  });
});

describe('RelayHandler.handleTranscriptActivity', () => {
  const transcriptUpdate = {
    session_id: 'sess1',
    cwd: '/Users/me/my-app',
    last_message: 'Running tests...',
    last_activity: new Date('2026-01-01T00:00:05.000Z'),
  };

  it('resolves a blocked session to working and broadcasts session_updated when the phone is connected', async () => {
    getSessionMock.mockReturnValue({
      session_id: 'sess1',
      cwd: '/Users/me/my-app',
      project_name: 'my-app',
      agent: 'claude-code',
      state: 'blocked',
      last_activity: new Date('2026-01-01T00:00:00.000Z'),
    });
    updateSessionMock.mockReturnValue({
      session_id: 'sess1',
      cwd: '/Users/me/my-app',
      project_name: 'my-app',
      agent: 'claude-code',
      state: 'working',
      last_message: 'Running tests...',
      last_activity: transcriptUpdate.last_activity,
    });

    const ws = fakeWsServer(true);
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleTranscriptActivity(transcriptUpdate);

    expect(updateSessionMock).toHaveBeenCalledWith('sess1', expect.objectContaining({
      state: 'working',
      last_message: 'Running tests...',
    }));
    expect(ws.sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session_updated',
      session_id: 'sess1',
    }));
    expect(sendFcmEventMock).not.toHaveBeenCalled();
  });

  it('sends session_updated via FCM when resolving a blocked session while the phone is disconnected', async () => {
    getConfigMock.mockResolvedValue({ fcm_token: 'token123' });
    sendFcmEventMock.mockResolvedValue('sent');
    getSessionMock.mockReturnValue({
      session_id: 'sess1',
      cwd: '/Users/me/my-app',
      project_name: 'my-app',
      agent: 'claude-code',
      state: 'blocked',
      last_activity: new Date('2026-01-01T00:00:00.000Z'),
    });
    updateSessionMock.mockReturnValue({
      session_id: 'sess1',
      cwd: '/Users/me/my-app',
      project_name: 'my-app',
      agent: 'claude-code',
      state: 'working',
      last_message: 'Running tests...',
      last_activity: transcriptUpdate.last_activity,
    });

    const ws = fakeWsServer(false, 'shared-secret');
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleTranscriptActivity(transcriptUpdate);

    expect(ws.sendEvent).not.toHaveBeenCalled();
    expect(sendFcmEventMock).toHaveBeenCalledWith(
      'token123',
      expect.objectContaining({ type: 'session_updated', session_id: 'sess1' }),
      'shared-secret'
    );
  });

  it('does not change session state for non-blocked sessions, just refreshes last activity', async () => {
    getSessionMock.mockReturnValue({
      session_id: 'sess1',
      cwd: '/Users/me/my-app',
      project_name: 'my-app',
      agent: 'claude-code',
      state: 'working',
      last_activity: new Date('2026-01-01T00:00:00.000Z'),
    });

    const ws = fakeWsServer(true);
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleTranscriptActivity(transcriptUpdate);

    expect(updateSessionMock).toHaveBeenCalledWith('sess1', {
      last_message: 'Running tests...',
      last_activity: transcriptUpdate.last_activity,
    });
    expect(ws.sendEvent).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown session', async () => {
    getSessionMock.mockReturnValue(undefined);

    const ws = fakeWsServer(true);
    const handler = new RelayHandler(ws, 'agentvigil-topic');
    await handler.handleTranscriptActivity(transcriptUpdate);

    expect(updateSessionMock).not.toHaveBeenCalled();
    expect(ws.sendEvent).not.toHaveBeenCalled();
  });
});

describe('RelayHandler.handlePhoneCommand', () => {
  it('calls keystroke-injector.approvePermission when approve command received', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await handler.handlePhoneCommand({ type: 'approve', session_id: 'sess1' });

    expect(approvePermissionMock).toHaveBeenCalledWith('sess1');
    expect(denyPermissionMock).not.toHaveBeenCalled();
  });

  it('calls keystroke-injector.denyPermission when deny command received', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await handler.handlePhoneCommand({ type: 'deny', session_id: 'sess1' });

    expect(denyPermissionMock).toHaveBeenCalledWith('sess1');
    expect(approvePermissionMock).not.toHaveBeenCalled();
  });

  it('routes send_prompt to keystroke-injector.sendPromptToSession', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await handler.handlePhoneCommand({ type: 'send_prompt', session_id: 'sess1', payload: 'continue' });

    expect(sendPromptToSessionMock).toHaveBeenCalledWith('sess1', 'continue');
    expect(approvePermissionMock).not.toHaveBeenCalled();
  });

  it('ignores send_prompt when payload is missing', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');
    await expect(
      handler.handlePhoneCommand({ type: 'send_prompt', session_id: 'sess1' })
    ).resolves.toBeUndefined();

    expect(sendPromptToSessionMock).not.toHaveBeenCalled();
  });

  it('never throws even when the underlying keystroke-injector call rejects', async () => {
    approvePermissionMock.mockRejectedValue(new Error('all strategies failed'));
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');

    await expect(handler.handlePhoneCommand({ type: 'approve', session_id: 'sess1' })).resolves.toBeUndefined();
  });

  it('resolves the session to working and broadcasts session_updated after approve', async () => {
    getSessionMock.mockReturnValue({ session_id: 'sess1', state: 'blocked' });
    updateSessionMock.mockReturnValue({
      session_id: 'sess1',
      project_name: 'my-app',
      cwd: '/Users/me/my-app',
      agent: 'claude-code',
      state: 'working',
      last_activity: new Date('2026-01-01T00:00:00.000Z'),
      last_message: 'Approved',
    });
    const ws = fakeWsServer(true);
    const handler = new RelayHandler(ws, 'agentvigil-topic');

    await handler.handlePhoneCommand({ type: 'approve', session_id: 'sess1' });

    expect(updateSessionMock).toHaveBeenCalledWith('sess1', { state: 'working' });
    expect(ws.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_updated', session_id: 'sess1', message: 'Approved' })
    );
  });

  it('resolves the session to working and broadcasts session_updated after deny', async () => {
    getSessionMock.mockReturnValue({ session_id: 'sess1', state: 'blocked' });
    updateSessionMock.mockReturnValue({
      session_id: 'sess1',
      project_name: 'my-app',
      cwd: '/Users/me/my-app',
      agent: 'claude-code',
      state: 'working',
      last_activity: new Date('2026-01-01T00:00:00.000Z'),
      last_message: 'Denied',
    });
    const ws = fakeWsServer(true);
    const handler = new RelayHandler(ws, 'agentvigil-topic');

    await handler.handlePhoneCommand({ type: 'deny', session_id: 'sess1' });

    expect(updateSessionMock).toHaveBeenCalledWith('sess1', { state: 'working' });
    expect(ws.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_updated', session_id: 'sess1', message: 'Denied' })
    );
  });

  it('does not broadcast session_updated when the phone is not connected, but still resolves the session', async () => {
    getSessionMock.mockReturnValue({ session_id: 'sess1', state: 'blocked' });
    updateSessionMock.mockReturnValue({
      session_id: 'sess1',
      project_name: 'my-app',
      cwd: '/Users/me/my-app',
      agent: 'claude-code',
      state: 'working',
      last_activity: new Date('2026-01-01T00:00:00.000Z'),
    });
    const ws = fakeWsServer(false);
    const handler = new RelayHandler(ws, 'agentvigil-topic');

    await handler.handlePhoneCommand({ type: 'approve', session_id: 'sess1' });

    expect(updateSessionMock).toHaveBeenCalledWith('sess1', { state: 'working' });
    expect(ws.sendEvent).not.toHaveBeenCalled();
  });

  it('does not touch the session store or broadcast for an unknown session', async () => {
    getSessionMock.mockReturnValue(undefined);
    const ws = fakeWsServer(true);
    const handler = new RelayHandler(ws, 'agentvigil-topic');

    await handler.handlePhoneCommand({ type: 'deny', session_id: 'does-not-exist' });

    expect(updateSessionMock).not.toHaveBeenCalled();
    expect(ws.sendEvent).not.toHaveBeenCalled();
  });

  it('saves the FCM token to config on register_fcm_token', async () => {
    getConfigMock.mockResolvedValue({ fcm_token: undefined });
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');

    await handler.handlePhoneCommand({
      type: 'register_fcm_token',
      session_id: '',
      token: 'token123',
      device_name: 'Pixel 8',
    });

    expect(saveConfigMock).toHaveBeenCalledWith(expect.objectContaining({ fcm_token: 'token123' }));
  });

  it('ignores register_fcm_token when the token is missing', async () => {
    const handler = new RelayHandler(fakeWsServer(false), 'agentvigil-topic');

    await handler.handlePhoneCommand({ type: 'register_fcm_token', session_id: '' });

    expect(getConfigMock).not.toHaveBeenCalled();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });
});
