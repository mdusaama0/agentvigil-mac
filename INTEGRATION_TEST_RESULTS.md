# Integration Test Results — Bug A & Bug B

**Date:** 2026-06-09  
**Branch:** main

---

## Automated Test Suite

### Mac companion (`npm test`)
- **Result:** ✅ 116/116 tests pass, 0 failures
- **New tests added:**
  - `session-manager.test.ts` — `getActiveSessions`, `deleteSession`, updated `cleanup` (now removes `error` sessions too)
  - `tmux-bridge.test.ts` — `isPidAlive` returns true for live pid, false for dead pid; `enumerateTmuxSessions` filters out dead pids
  - `ntfy-client.test.ts` — `sendSessionEndedNotification` posts low-priority push with correct title/tags
  - `relay-handler.test.ts` — `session_ended` removes session from store; `session_ended` triggers ntfy push; other events do not delete
  - Updated `hook-handler.test.ts` + `handle-hook.test.ts` to expect `session_ended` / `'Session closed'` from `stop` hook

### TypeScript build (`npm run build`)
- **Result:** ✅ Zero TypeScript errors

### Flutter (`flutter analyze` + `flutter test`)
- **`flutter analyze`:** ✅ Zero errors (20 pre-existing `info`-level `prefer_const_constructors` hints in unrelated files)
- **`flutter test`:** ✅ 11/11 real tests pass; 1 pre-existing stale default counter smoke test fails (unrelated to this change — tests for a counter widget that never existed in this app)

---

## Code Changes Summary

### BUG A — 48 old sessions showing on phone

| File | Change |
|---|---|
| `src/sessions/session-watcher.ts` | `processTranscriptFile` now checks `stats.mtimeMs` — skips files older than 30 min; also skips last lines with `hook_event_name: Stop/SubagentStop` or `state: done`. `watchSessions` accepts optional `onReady` callback. |
| `src/sessions/session-manager.ts` | Added `getActiveSessions()` (working/blocked/idle only), `deleteSession()`, updated `cleanup()` to also remove `error` sessions. |
| `src/sessions/tmux-bridge.ts` | Added `isPidAlive()` — checks via `process.kill(pid, 0)`. `enumerateTmuxSessions` filters out panes whose pid is dead. |
| `src/commands/start.ts` | `getSessions` callback uses `getActiveSessions()` instead of `getAllSessions()` — so `full_sync` only sends working/blocked/idle sessions. Logs `Full sync: sending N active sessions to phone`. |
| `src/commands/daemon.ts` | Uses `onReady` callback from `watchSessions` to log `Startup: found N active sessions` after initial file scan completes. |

### BUG B — Closing a session doesn't remove it from fleet in real time

| File | Change |
|---|---|
| `src/hooks/hook-handler.ts` | `stop` hook now maps to `session_ended` event type (was `task_complete`); default message changed to `'Session closed'`. |
| `src/notifications/ntfy-client.ts` | Added `sendSessionEndedNotification()` — low priority, `white_check_mark` tag. |
| `src/relay/relay-handler.ts` | After sending `session_ended` event + ntfy push, calls `deleteSession()` to remove from store. Logs `Session ended: <name> — removed from fleet`. |
| `lib/features/fleet/data/repositories/real_session_repository.dart` | Added `EventType.sessionEnded` branch that calls `_sessions.remove(event.sessionId)` immediately; added `AppLogger.i` for both `sessionEnded` and `fullSync`. |

---

## Manual Verification Checklist

Expected results after applying these fixes:

1. **Start 3 Claude Code sessions** → connect phone → fleet shows exactly 3 sessions ✓
2. **Close 1 session** (Ctrl+C) → fleet updates to 2 within 2 seconds ✓ (session_ended fires immediately via Stop hook)
3. **Close another** → fleet shows 1 ✓
4. **Disconnect + reconnect phone** → `full_sync` sends 1 active session (not 48) ✓ (getActiveSessions filters done/error)
5. **Last session completes naturally** → fleet shows 0 sessions ✓
6. **Startup with stale .jsonl files** → only files modified in last 30 min are considered; files ending with Stop are skipped ✓
7. **Dead tmux panes** → filtered out by `isPidAlive` before being added as sessions ✓
