import { logger } from '../utils/logger.js';
import {
  deleteSession,
  getAllSessions,
  getSession,
  updateSession,
  type Session,
} from './session-manager.js';
import { detectAgentProcesses, findSessionFileForCwd, isPidAlive } from './process-detector.js';

export const PROCESS_POLL_INTERVAL_MS = 10_000;

export interface SessionPoller {
  stop(): void;
}

/**
 * Reconciles the OS process table with the in-memory session store every
 * PROCESS_POLL_INTERVAL_MS milliseconds.
 *
 * - Sessions whose process has died are removed immediately.
 * - Running agent processes not yet in the store are added.
 * - done/error sessions are left for cleanup() to expire.
 *
 * Runs the first poll synchronously (awaited) before returning so the store
 * is fully populated when the caller proceeds.
 */
export async function startSessionPolling(
  onSessionAdded: (session: Session) => void,
  onSessionRemoved: (sessionId: string) => void,
  intervalMs = PROCESS_POLL_INTERVAL_MS
): Promise<SessionPoller> {
  async function poll(): Promise<void> {
    try {
      const liveProcs = await detectAgentProcesses();

      // ── Remove dead sessions ──────────────────────────────────────────
      for (const session of getAllSessions()) {
        // done/error sessions are managed by cleanup() — leave them alone
        if (session.state === 'done' || session.state === 'error') continue;

        if (session.pid && !isPidAlive(session.pid)) {
          logger.info(`Session terminated (pid ${session.pid} dead): ${session.project_name}`);
          deleteSession(session.session_id);
          onSessionRemoved(session.session_id);
        }
      }

      // ── Add new sessions ──────────────────────────────────────────────
      for (const proc of liveProcs) {
        // Already tracked by pid?
        const byPid = getAllSessions().find(s => s.pid === proc.pid);
        if (byPid) continue;

        const fileInfo = await findSessionFileForCwd(proc.cwd);
        if (!fileInfo) {
          // JSONL not written yet — session is just starting; next poll will catch it.
          continue;
        }

        // Already tracked by session_id (hook may have created it first)?
        if (getSession(fileInfo.sessionId)) {
          const existing = getSession(fileInfo.sessionId)!;
          if (!existing.pid) {
            // Attach pid so future dead-process checks work.
            updateSession(fileInfo.sessionId, { pid: proc.pid });
          }
          continue;
        }

        const session = updateSession(fileInfo.sessionId, {
          cwd: proc.cwd,
          agent: proc.agentType,
          state: 'working',
          last_message: fileInfo.lastMessage,
          last_activity: new Date(),
          pid: proc.pid,
        });

        logger.info(`New session detected: ${session.project_name} (pid: ${proc.pid})`);
        onSessionAdded(session);
      }
    } catch (err) {
      logger.warn('Session poll error', err);
    }
  }

  await poll(); // first run awaited — store is populated when we return
  const activeSessions = getAllSessions().filter(s => s.state === 'working' || s.state === 'blocked' || s.state === 'idle');
  logger.info(`Session poll ready: ${activeSessions.length} active session(s)`);
  const timer = setInterval(() => void poll(), intervalMs);
  return { stop: () => clearInterval(timer) };
}
