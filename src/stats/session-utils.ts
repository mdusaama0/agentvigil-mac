import { isBlocklisted } from '../sessions/session-watcher.js';

/** Claude Code names transcript files `{uuid}.jsonl` — reject test/dev ids like "abc123". */
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTrackableClaudeSession(sessionId: string, cwd?: string): boolean {
  if (!CLAUDE_SESSION_ID.test(sessionId)) return false;
  if (cwd && isBlocklisted(cwd)) return false;
  return true;
}
