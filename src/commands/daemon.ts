/**
 * Shared daemon runtime — used by both `setup` (post-pairing) and `start`.
 *
 * Caller is responsible for having already:
 *   - created and started the AgentVigilWsServer
 *   - set the shared secret on the WS server
 *   - (optionally) started a cloudflared tunnel
 */

import os from 'node:os';
import { logger } from '../utils/logger.js';
import { RelayHandler } from '../relay/relay-handler.js';
import {
  cleanup,
  getActiveSessions,
  getAllSessions,
  updateSession,
  type AgentKind,
  type Session,
  type SessionState,
} from '../sessions/session-manager.js';
import { startSessionPolling } from '../sessions/session-poller.js';
import { watchSessions } from '../sessions/session-watcher.js';
import { enumerateTmuxSessions, findTmuxPaneForSession } from '../sessions/tmux-bridge.js';
import type { AgentVigilWsServer } from '../tunnel/websocket-server.js';
import type { TunnelManager } from '../tunnel/tunnel-manager.js';
import type { AgentEvent, AgentEventType } from '../types.js';

export const TMUX_POLL_INTERVAL_MS = 5_000;
export const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export const EVENT_TYPE_FOR_STATE: Record<SessionState, AgentEventType> = {
  working: 'session_started',
  blocked: 'permission_prompt',
  done: 'task_complete',
  error: 'session_error',
  idle: 'idle_waiting',
};

/** Returns the first non-loopback IPv4 address of this machine. */
export function getLocalIPv4(): string | undefined {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

export function toAgentEvent(session: Session): AgentEvent {
  return {
    type: EVENT_TYPE_FOR_STATE[session.state],
    session_id: session.session_id,
    project_name: session.project_name,
    cwd: session.cwd,
    agent: session.agent satisfies AgentKind,
    message: session.last_message ?? session.state,
    timestamp: session.last_activity.toISOString(),
    pid: session.pid,
    permission_command: session.permission_command,
    tool_name: session.tool_name,
  };
}

export async function syncTmuxPanes(): Promise<void> {
  try {
    const panes = await enumerateTmuxSessions();
    if (panes.length === 0) return;

    for (const session of getAllSessions()) {
      const pane = findTmuxPaneForSession(session.cwd, panes);
      if (pane && pane.pane_id !== session.tmux_pane_id) {
        updateSession(session.session_id, { tmux_pane_id: pane.pane_id, pid: pane.pid });
      }
    }
  } catch (err) {
    logger.warn('Failed to sync tmux panes', err);
  }
}

export interface DaemonOptions {
  wsServer: AgentVigilWsServer;
  tunnelManager?: TunnelManager;
  ntfyTopic: string;
}

/**
 * Starts the relay, session watching, and tmux polling loops.
 * Resolves when SIGINT/SIGTERM is received.
 * The caller should NOT stop wsServer or tunnelManager before calling this.
 */
export async function runDaemon({ wsServer, tunnelManager, ntfyTopic }: DaemonOptions): Promise<void> {
  const relay = new RelayHandler(wsServer, ntfyTopic);

  // ── Process-based session detection ─────────────────────────────────────
  // Polls every 10 s via pgrep + lsof.  First poll is awaited so the store
  // is fully populated before we advertise readiness.
  const poller = await startSessionPolling(
    (session) => {
      // New session detected by the poller — push to phone immediately.
      if (wsServer.isPhoneConnected) {
        wsServer.sendEvent(toAgentEvent(session));
      }
    },
    (sessionId) => {
      // Session process died — remove from phone fleet immediately.
      if (wsServer.isPhoneConnected) {
        wsServer.sendEvent({
          type: 'session_ended',
          session_id: sessionId,
          project_name: '',
          cwd: '',
          agent: 'claude-code',
          message: 'Session terminated',
          timestamp: new Date().toISOString(),
        });
      }
    }
  );
  logger.info(`Session poll ready: ${getActiveSessions().length} active session(s)`);

  // First poll complete — push fresh state if phone already connected.
  if (wsServer.isPhoneConnected) {
    wsServer.sendFullSync();
    logger.info('Sent post-startup full sync to already-connected phone');
  }

  // ── JSONL watcher: live last_message updates for existing sessions ───────
  // ignoreInitial=true — poller owns session creation; this is supplementary.
  // Also the only signal that a `blocked` session resumed after the user
  // approved/denied its permission prompt directly in the Mac terminal (no
  // hook fires for that) — see RelayHandler.handleTranscriptActivity.
  const watcher = watchSessions((update) => {
    void relay.handleTranscriptActivity(update);
  });

  const tmuxTimer  = setInterval(() => { void syncTmuxPanes(); }, TMUX_POLL_INTERVAL_MS);
  const cleanTimer = setInterval(() => cleanup(), SESSION_CLEANUP_INTERVAL_MS);
  void syncTmuxPanes();

  logger.success('✅ AgentVigil is running — watching for Claude Code sessions');

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('Shutting down AgentVigil...');
      clearInterval(tmuxTimer);
      clearInterval(cleanTimer);
      poller.stop();
      await watcher.close();
      tunnelManager?.stop();
      wsServer.stop();
      resolve();
    };

    process.on('SIGINT',  () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });
}
