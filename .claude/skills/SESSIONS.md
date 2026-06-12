# SKILL: Session Detection & Tmux Bridge
# Read before touching session-manager.ts, session-watcher.ts, or tmux-bridge.ts

## Three-Layer Session Detection

### Layer 1: Hook Events (source of truth)
When Claude Code fires a hook, we get the session_id, cwd, and event type directly.
Store this in an in-memory Map<session_id, Session>.

### Layer 2: JSONL Watcher (supplementary state)
Watch ~/.claude/projects/ recursively. Each subdirectory has .jsonl files.
Parse the last line of each .jsonl to get the most recent message/state.

```typescript
import chokidar from 'chokidar';

export function watchSessions(onUpdate: (session: Partial<Session>) => void): void {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  chokidar.watch(`${projectsDir}/**/*.jsonl`, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  }).on('change', async (filePath) => {
    const lastLine = await readLastLine(filePath);
    if (!lastLine) return;
    try {
      const entry = JSON.parse(lastLine);
      onUpdate({ cwd: extractCwdFromPath(filePath), lastMessage: entry.message });
    } catch { /* malformed line */ }
  });
}
```

### Layer 3: tmux Enumeration (startup sync)
On startup, enumerate all tmux panes to find existing sessions:

```typescript
export async function enumerateTmuxSessions(): Promise<TmuxPane[]> {
  try {
    const { stdout } = await exec(
      'tmux list-panes -a -F "#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}"'
    );

    return stdout.trim().split('\n')
      .map(line => {
        const [pane_id, pid, command, cwd] = line.split('|');
        return { pane_id, pid, command, cwd };
      })
      .filter(p => ['claude', 'codex', 'amp'].some(a => p.command.includes(a)));
  } catch {
    // tmux not running or not installed
    return [];
  }
}
```

## Session State Machine
```typescript
type SessionState = 'working' | 'blocked' | 'done' | 'error' | 'idle';

// Transitions:
// hook:permission_prompt → blocked
// hook:stop             → done
// hook:subagent_stop    → working (sub-agent done, parent continues)
// hook:idle_prompt      → idle
// command:approve/deny  → working (after approval)
// timeout (5min no activity) → consider session ended
```

## Tmux Keystroke Injection (Approve/Deny)

```typescript
// src/sessions/tmux-bridge.ts
export async function approvePermission(sessionId: string): Promise<boolean> {
  const session = sessionStore.get(sessionId);
  if (!session?.tmuxPaneId) {
    logger.warn(`No tmux pane found for session ${sessionId} — cannot auto-approve`);
    await sendMacNotification(
      `AgentVigil: Please approve in terminal`,
      session?.projectName ?? 'Unknown project'
    );
    return false;
  }

  await exec(`tmux send-keys -t ${session.tmuxPaneId} 'y' Enter`);
  logger.success(`Approved permission for ${session.projectName}`);
  return true;
}

export async function denyPermission(sessionId: string): Promise<boolean> {
  const session = sessionStore.get(sessionId);
  if (!session?.tmuxPaneId) return false;

  await exec(`tmux send-keys -t ${session.tmuxPaneId} 'n' Enter`);
  logger.success(`Denied permission for ${session.projectName}`);
  return true;
}
```

## Matching Session to Tmux Pane
When a hook fires, we have cwd. Match to tmux pane by cwd:
```typescript
function findTmuxPaneForSession(cwd: string, panes: TmuxPane[]): TmuxPane | undefined {
  return panes.find(p => p.cwd === cwd || cwd.startsWith(p.cwd));
}
```

## Project Name from CWD
```typescript
function projectNameFromCwd(cwd: string): string {
  return path.basename(cwd);
}
```

## Session Cleanup
Remove sessions from the store after 30 minutes of inactivity:
```typescript
setInterval(() => {
  const thirtyMinsAgo = Date.now() - 30 * 60 * 1000;
  for (const [id, session] of sessionStore.entries()) {
    if (session.lastActivity.getTime() < thirtyMinsAgo && session.state === 'done') {
      sessionStore.delete(id);
    }
  }
}, 5 * 60 * 1000);
```
