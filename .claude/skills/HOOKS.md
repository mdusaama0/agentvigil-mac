# SKILL: Claude Code Hook Registration
# Read before touching hook-manager.ts or hook-handler.ts

## What Hooks Are
Claude Code executes shell commands on lifecycle events. AgentVigil registers
itself as a hook handler by writing to ~/.claude/settings.json.

## Hook Types We Use
- `Notification` with matcher `permission_prompt` — session blocked waiting for approval
- `Notification` with matcher `idle_prompt` — session idle 60s waiting for input
- `Stop` — session completed (agent stopped cleanly)
- `SubagentStop` — a sub-agent within a session stopped

## Hook JSON (received on stdin)
```typescript
// For Notification hooks:
{
  "session_id": "abc123def456",
  "transcript_path": "/Users/dev/.claude/projects/my-api-backend/abc123.jsonl",
  "cwd": "/Users/dev/my-api-backend",
  "hook_event_name": "Notification",
  "notification_type": "permission_prompt",
  "message": "Claude wants to run: rm -rf node_modules"
}

// For Stop hooks:
{
  "session_id": "abc123def456",
  "transcript_path": "/Users/dev/.claude/projects/my-api-backend/abc123.jsonl",
  "cwd": "/Users/dev/my-api-backend",
  "hook_event_name": "Stop"
}
```

## Reading stdin in hook handler
```typescript
// src/hooks/hook-handler.ts
export async function handleHook(eventType: string): Promise<void> {
  const raw = await readStdin();
  const payload = JSON.parse(raw) as HookPayload;
  // process...
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    // Timeout after 2s in case stdin is empty
    setTimeout(() => resolve(data || '{}'), 2000);
  });
}
```

## Safe Settings Merge
NEVER overwrite existing settings. Always read → merge → write:
```typescript
export async function registerHooks(): Promise<void> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  let existing: any = {};
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    existing = JSON.parse(raw);
  } catch {
    // File doesn't exist yet — start fresh
  }

  // Deep merge hooks
  const ourHooks = buildHookConfig();
  existing.hooks = mergeHooks(existing.hooks ?? {}, ourHooks);

  // Backup before writing
  if (await fileExists(settingsPath)) {
    await fs.copyFile(settingsPath, settingsPath + '.bak');
  }

  await fs.writeFile(settingsPath, JSON.stringify(existing, null, 2));
  logger.success('Hooks registered in ~/.claude/settings.json');
}
```

## Unregistering Hooks (for uninstall command)
```typescript
export async function unregisterHooks(): Promise<void> {
  // Read settings, remove only our hook commands (those containing 'agentvigil hook')
  // Leave all other hooks untouched
}
```

## Testing Hook Handler
```typescript
// Pipe mock JSON to test:
echo '{"session_id":"test","cwd":"/tmp/test","hook_event_name":"Notification","notification_type":"permission_prompt","message":"rm -rf node_modules"}' | npx agentvigil hook permission_prompt
```
