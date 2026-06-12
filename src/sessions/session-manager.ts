import path from 'node:path';

export type SessionState = 'working' | 'blocked' | 'done' | 'error' | 'idle';
export type AgentKind = 'claude-code' | 'codex' | 'amp';
export type HookEventType = 'permission_prompt' | 'idle_prompt' | 'stop' | 'subagent_stop';

export interface Session {
  session_id: string;
  cwd: string;
  project_name: string;
  agent: AgentKind;
  state: SessionState;
  last_activity: Date;
  last_message?: string;
  tmux_pane_id?: string;
  pid?: string;
  /** The shell command awaiting approval. Only meaningful while state === 'blocked'. */
  permission_command?: string;
  /** The tool requesting approval (e.g. 'Bash', 'Write'). Only meaningful while state === 'blocked'. */
  tool_name?: string;
}

// done/error sessions linger briefly so the phone can display the final state
// before they disappear. Active sessions are removed immediately by the process
// poller when their pid dies — no time-based threshold for those.
const DONE_SESSION_LINGER_MS = 5 * 60 * 1000;

// Mirrors the state machine documented in SESSIONS.md — subagent_stop returns
// the parent session to 'working' rather than marking it 'done'.
const STATE_AFTER_HOOK_EVENT: Record<HookEventType, SessionState> = {
  permission_prompt: 'blocked',
  idle_prompt: 'idle',
  stop: 'done',
  subagent_stop: 'working',
};

export function stateAfterHookEvent(hookType: HookEventType): SessionState {
  return STATE_AFTER_HOOK_EVENT[hookType];
}

export function projectNameFromCwd(cwd: string): string {
  return path.basename(cwd);
}

const sessionStore = new Map<string, Session>();

export function updateSession(sessionId: string, changes: Partial<Omit<Session, 'session_id'>>): Session {
  const existing = sessionStore.get(sessionId);
  const cwd = changes.cwd ?? existing?.cwd ?? '';
  const state = changes.state ?? existing?.state ?? 'working';

  const session: Session = {
    session_id: sessionId,
    cwd,
    project_name: changes.project_name ?? existing?.project_name ?? projectNameFromCwd(cwd),
    agent: changes.agent ?? existing?.agent ?? 'claude-code',
    state,
    last_activity: changes.last_activity ?? new Date(),
    last_message: changes.last_message ?? existing?.last_message,
    tmux_pane_id: changes.tmux_pane_id ?? existing?.tmux_pane_id,
    pid: changes.pid ?? existing?.pid,
    // Stale once the session leaves 'blocked' — drop it so a later full_sync
    // doesn't re-show a permission card for an already-resolved prompt.
    permission_command: state === 'blocked'
      ? (changes.permission_command ?? existing?.permission_command)
      : undefined,
    tool_name: state === 'blocked'
      ? (changes.tool_name ?? existing?.tool_name)
      : undefined,
  };

  sessionStore.set(sessionId, session);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  return sessionStore.get(sessionId);
}

/** Returns the first session whose cwd matches exactly, or undefined. */
export function getSessionByCwd(cwd: string): Session | undefined {
  for (const session of sessionStore.values()) {
    if (session.cwd === cwd) return session;
  }
  return undefined;
}

export function getAllSessions(): Session[] {
  return [...sessionStore.values()];
}

/** Returns only sessions that are currently active (working / blocked / idle). */
export function getActiveSessions(): Session[] {
  return [...sessionStore.values()].filter(
    (s) => s.state === 'working' || s.state === 'blocked' || s.state === 'idle'
  );
}

export function deleteSession(sessionId: string): void {
  sessionStore.delete(sessionId);
}

/**
 * Removes done/error sessions that have lingered for over 5 minutes.
 * Active (working/blocked/idle) sessions are removed immediately by the process
 * poller when their pid dies — not by this function.
 * Returns the removed session ids.
 */
export function cleanup(now: Date = new Date()): string[] {
  const removed: string[] = [];

  for (const [id, session] of sessionStore.entries()) {
    if (session.state !== 'done' && session.state !== 'error') continue;
    const inactiveMs = now.getTime() - session.last_activity.getTime();
    if (inactiveMs > DONE_SESSION_LINGER_MS) {
      sessionStore.delete(id);
      removed.push(id);
    }
  }

  return removed;
}

export function clearSessions(): void {
  sessionStore.clear();
}
