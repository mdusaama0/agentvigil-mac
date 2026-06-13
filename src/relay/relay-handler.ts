import { logger } from '../utils/logger.js';
import { getConfig, saveConfig } from '../utils/config.js';
import { deleteSession, getSession, getSessionByCwd, updateSession } from '../sessions/session-manager.js';
import { approvePermission, denyPermission, sendPromptToSession } from '../sessions/keystroke-injector.js';
import {
  sendErrorNotification,
  sendIdleNotification,
  sendPermissionNotification,
  sendTaskCompleteNotification,
} from '../notifications/ntfy-client.js';
import { sendFcmEvent } from '../notifications/fcm-client.js';
import type { Session, SessionState } from '../sessions/session-manager.js';
import type { SessionUpdate } from '../sessions/session-watcher.js';
import type { AgentEvent, AgentEventType, PhoneCommand } from '../types.js';

// heartbeat/full_sync are outbound-only summaries — they don't represent a
// change in a session's own state, so they're intentionally absent here.
const SESSION_STATE_FOR_EVENT: Partial<Record<AgentEventType, SessionState>> = {
  permission_prompt: 'blocked',
  task_complete: 'done',
  session_error: 'error',
  idle_waiting: 'idle',
  session_started: 'working',
  session_ended: 'done',
};

export interface RelayWsServer {
  sendEvent(event: AgentEvent): void;
  readonly isPhoneConnected: boolean;
  /** The NaCl shared secret for the paired phone, or undefined if not yet paired — used to encrypt FCM payloads identically to WS events. */
  getSharedSecret(): string | undefined;
}

/**
 * Routes AgentEvents from hook-handler.ts to the session store, the phone
 * (over WebSocket when connected, and always via ntfy as a safety net), and
 * routes phone commands (approve/deny/send_prompt) back to tmux-bridge.
 */
// A session ending fires both a `task_complete`-mapped event and (depending
// on the hook) a `session_ended`-mapped one in quick succession. Both now
// resolve to the same "Task Complete" push, so this guards against sending
// it twice for the same session within a short window.
const TASK_COMPLETE_DEDUP_WINDOW_MS = 10_000;

// Claude Code can fire Stop and a permission_prompt Notification within
// milliseconds of each other while merely pausing for approval — only that
// near-simultaneous Stop is spurious. A Stop arriving well after the prompt
// means the user actually responded (in the Mac terminal) and the turn ran
// to completion, so it must be processed to clear the blocked state.
const SPURIOUS_STOP_WINDOW_MS = 3_000;

export class RelayHandler {
  private readonly recentTaskCompleteNotifications = new Map<string, number>();

  constructor(
    private readonly wsServer: RelayWsServer,
    private readonly ntfyTopic: string
  ) {}

  async handleAgentEvent(event: AgentEvent): Promise<void> {
    try {
      const previous = getSession(event.session_id);

      // Claude Code fires a spurious Stop hook (session_ended) immediately
      // before and/or after a permission_prompt Notification while the agent
      // is merely paused waiting for approval — not actually finished. Only
      // treat it as spurious within SPURIOUS_STOP_WINDOW_MS of the prompt; a
      // later Stop means the user responded (e.g. in the Mac terminal) and
      // the turn genuinely completed, so let it clear the blocked state.
      if (
        event.type === 'session_ended' &&
        previous?.state === 'blocked' &&
        Date.now() - previous.last_activity.getTime() < SPURIOUS_STOP_WINDOW_MS
      ) {
        logger.dim(`Ignoring spurious Stop for ${event.project_name} — session is blocked on a permission prompt`);
        return;
      }

      this.applyToSessionStore(event);

      if (this.wsServer.isPhoneConnected) {
        this.wsServer.sendEvent(event);
      }

      // ntfy is the safety net — send it even when the phone is live on WS,
      // since the socket can drop without us knowing (see NOTIFICATIONS.md).
      await this.pushNtfy(event, previous);

      if (event.type === 'session_ended') {
        // A permission_prompt for this session may have landed while the ntfy
        // push above was in flight, putting it back into 'blocked'. Don't
        // delete a session that's now awaiting approval again.
        if (getSession(event.session_id)?.state === 'blocked') {
          logger.dim(`Skipping deleteSession for ${event.project_name} — now blocked on a permission prompt`);
          return;
        }

        deleteSession(event.session_id);
        logger.info(`Session ended: ${event.project_name} — removed from fleet`);
      }
    } catch (err) {
      logger.warn('Failed to relay agent event', err);
    }
  }

  async handlePhoneCommand(command: PhoneCommand): Promise<void> {
    try {
      switch (command.type) {
        case 'approve': {
          logger.info(`[ApproveDeny] approve command received for session: ${command.session_id}`);
          logger.info(`[ApproveDeny] session ${command.session_id} ${getSession(command.session_id) ? 'found' : 'not found'}`);
          const approved = await approvePermission(command.session_id);
          logger.info(`[ApproveDeny] keystroke result (approve → '1'): ${approved ? 'SUCCESS' : 'FAILED'}`);
          this.broadcastSessionUpdated(command.session_id);
          return;
        }
        case 'deny': {
          logger.info(`[ApproveDeny] deny command received for session: ${command.session_id}`);
          logger.info(`[ApproveDeny] session ${command.session_id} ${getSession(command.session_id) ? 'found' : 'not found'}`);
          const denied = await denyPermission(command.session_id);
          logger.info(`[ApproveDeny] keystroke result (deny → '3'): ${denied ? 'SUCCESS' : 'FAILED'}`);
          this.broadcastSessionUpdated(command.session_id);
          return;
        }
        case 'send_prompt':
          if (command.payload) {
            logger.info(`Sending prompt to session ${command.session_id}: "${command.payload}"`);
            await sendPromptToSession(command.session_id, command.payload);
          }
          return;
        case 'register_fcm_token': {
          if (!command.token) return;
          const config = await getConfig();
          config.fcm_token = command.token;
          await saveConfig(config);
          logger.success(`FCM token registered${command.device_name ? ` for ${command.device_name}` : ''}`);
          return;
        }
        case 'heartbeat':
          logger.dim('Heartbeat received from phone');
          this.wsServer.sendEvent({
            type: 'heartbeat',
            session_id: '',
            project_name: '',
            cwd: '',
            agent: 'claude-code',
            message: 'pong',
            timestamp: new Date().toISOString(),
          });
          return;
        default:
          logger.warn(`Unknown phone command type: ${(command as any).type}`);
      }
    } catch (err) {
      logger.warn('Failed to relay phone command', err);
    }
  }

  // Resolves a blocked session back to 'working' after the phone approves or
  // denies its permission prompt, and pushes the new state back to the phone
  // so the fleet card and session detail screen update without a reload.
  private broadcastSessionUpdated(sessionId: string): void {
    if (!getSession(sessionId)) {
      logger.warn(`[ApproveDeny] cannot broadcast session_updated — session ${sessionId} not found`);
      return;
    }

    const session = updateSession(sessionId, { state: 'working' });

    if (!this.wsServer.isPhoneConnected) {
      logger.info(`[ApproveDeny] session ${sessionId} set to working — phone not connected, skipping broadcast`);
      return;
    }

    this.wsServer.sendEvent({
      type: 'session_updated',
      session_id: session.session_id,
      project_name: session.project_name,
      cwd: session.cwd,
      agent: session.agent,
      message: session.last_message ?? 'working',
      timestamp: session.last_activity.toISOString(),
      pid: session.pid,
    });
    logger.info(`[ApproveDeny] session_updated broadcast sent for ${sessionId} (state: working)`);
  }

  /**
   * Called by the transcript watcher whenever a session's JSONL file is
   * appended to. Approving/denying a permission prompt directly in the Mac
   * terminal fires no hook AgentVigil listens for, so this transcript write
   * is the only signal that a `blocked` session has resumed. Resolve it back
   * to 'working' and broadcast `session_updated` so the fleet card leaves
   * PERM and the phone clears the standing permission notification — the
   * same effect as the phone's own approve/deny buttons.
   */
  async handleTranscriptActivity(update: SessionUpdate): Promise<void> {
    const session = getSession(update.session_id);
    if (!session) return;

    if (session.state !== 'blocked') {
      updateSession(update.session_id, {
        last_message: update.last_message,
        last_activity: update.last_activity,
      });
      return;
    }

    const resolved = updateSession(update.session_id, {
      state: 'working',
      last_message: update.last_message,
      last_activity: update.last_activity,
    });

    const resolvedEvent: AgentEvent = {
      type: 'session_updated',
      session_id: resolved.session_id,
      project_name: resolved.project_name,
      cwd: resolved.cwd,
      agent: resolved.agent,
      message: resolved.last_message ?? 'working',
      timestamp: resolved.last_activity.toISOString(),
      pid: resolved.pid,
    };

    if (this.wsServer.isPhoneConnected) {
      this.wsServer.sendEvent(resolvedEvent);
      logger.info(`[Transcript] session_updated broadcast sent for ${update.session_id} (resolved from blocked via terminal activity)`);
      return;
    }

    // Phone not connected (e.g. app killed) — FCM is the only way to clear
    // the standing permission notification.
    if (await this.tryFcm(resolvedEvent)) {
      logger.info(`[Transcript] session_updated sent via FCM for ${update.session_id} (resolved from blocked via terminal activity)`);
    } else {
      logger.info(`[Transcript] session ${update.session_id} resolved to working — phone not reachable, skipping broadcast`);
    }
  }

  /**
   * The session-poller can create an entry for a terminal's cwd before its
   * transcript file (and thus its real session_id) exists, keying it off a
   * stale/different session_id. When a hook event later arrives with the
   * terminal's real session_id, that would otherwise create a SECOND entry
   * for the same cwd — a duplicate fleet card, and one with no `pid`, so
   * approve/deny can't inject keystrokes. Merge the stale entry's pid/tmux
   * info into the new id, drop the stale entry, and tell the phone to remove
   * its (now-orphaned) card.
   */
  private reconcileDuplicateSession(event: AgentEvent): void {
    if (getSession(event.session_id)) return;

    const stale = getSessionByCwd(event.cwd);
    if (!stale || stale.session_id === event.session_id) return;

    updateSession(event.session_id, {
      pid: stale.pid,
      tmux_pane_id: stale.tmux_pane_id,
    });
    deleteSession(stale.session_id);

    if (this.wsServer.isPhoneConnected) {
      this.wsServer.sendEvent({
        type: 'session_ended',
        session_id: stale.session_id,
        project_name: stale.project_name,
        cwd: stale.cwd,
        agent: stale.agent,
        message: 'Replaced by a newer session for this terminal',
        timestamp: new Date().toISOString(),
      });
    }
  }

  private applyToSessionStore(event: AgentEvent): void {
    const state = SESSION_STATE_FOR_EVENT[event.type];
    if (!state) return;

    this.reconcileDuplicateSession(event);

    updateSession(event.session_id, {
      cwd: event.cwd,
      project_name: event.project_name,
      agent: event.agent,
      state,
      last_activity: new Date(event.timestamp),
      last_message: event.message,
      pid: event.pid,
      permission_command: event.permission_command,
      tool_name: event.tool_name,
    });
  }

  private async pushNtfy(event: AgentEvent, previous: Session | undefined): Promise<void> {
    switch (event.type) {
      case 'permission_prompt':
        if (await this.tryFcm(event)) return;
        await sendPermissionNotification(
          this.ntfyTopic,
          event.project_name,
          event.permission_command ?? event.message,
          event.session_id
        );
        return;
      case 'task_complete':
      case 'session_ended':
        // Session-end notifications never fire more than once per session
        // within the dedup window — see TASK_COMPLETE_DEDUP_WINDOW_MS.
        if (this.wasRecentlyNotified(event.session_id)) return;
        if (await this.tryFcm(event)) return;
        await sendTaskCompleteNotification(
          this.ntfyTopic,
          event.project_name,
          formatDuration(previous ? Date.now() - previous.last_activity.getTime() : 0)
        );
        return;
      case 'session_error':
        if (await this.tryFcm(event)) return;
        await sendErrorNotification(this.ntfyTopic, event.project_name, event.message);
        return;
      case 'idle_waiting':
        if (await this.tryFcm(event)) return;
        await sendIdleNotification(this.ntfyTopic, event.project_name, event.session_id);
        return;
      default:
        // session_started / heartbeat / full_sync have no dedicated push —
        // the WebSocket event is enough for those.
        return;
    }
  }

  /**
   * Sends `event` directly via FCM (works even when the app is killed) when a
   * phone FCM token is registered and a pairing shared secret is known.
   * Returns true if FCM handled it — the caller should skip the ntfy push to
   * avoid a duplicate notification. Returns false (no FCM token configured,
   * not yet paired, or the send failed) so the caller falls back to ntfy.
   */
  private async tryFcm(event: AgentEvent): Promise<boolean> {
    const sharedSecret = this.wsServer.getSharedSecret();
    if (!sharedSecret) return false;

    const config = await getConfig();
    if (!config.fcm_token) {
      logger.warn('No FCM token — using ntfy fallback (killed state will not work)');
      return false;
    }

    const result = await sendFcmEvent(config.fcm_token, event, sharedSecret);
    if (result === 'invalid-token') {
      config.fcm_token = undefined;
      await saveConfig(config);
    }
    return result === 'sent';
  }

  /** Records a notification for `sessionId` and returns whether one was already sent within the dedup window. */
  private wasRecentlyNotified(sessionId: string): boolean {
    const now = Date.now();
    const last = this.recentTaskCompleteNotifications.get(sessionId);
    if (last !== undefined && now - last < TASK_COMPLETE_DEDUP_WINDOW_MS) {
      return true;
    }
    this.recentTaskCompleteNotifications.set(sessionId, now);
    return false;
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}
