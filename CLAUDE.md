# AgentVigil Mac Companion — Claude Code Instructions

## What This Is
A Node.js + TypeScript CLI tool (`npx agentvigil`) that acts as the bridge between
Claude Code terminal sessions on a Mac and the AgentVigil Android/iOS app.

**Zero server required.** Architecture:
```
Claude Code hooks
      ↓
Mac Companion (this repo)
      ├── cloudflared tunnel ←→ AgentVigil mobile app (live WebSocket)
      └── ntfy.sh curl       →  Phone push notifications (background)
```

## Quick Start (what the end user runs)
```bash
npx agentvigil          # first run: setup + show QR code
npx agentvigil start    # start monitoring (after setup)
npx agentvigil status   # show current sessions
npx agentvigil unpair   # revoke pairing
```

---

## Project Structure
```
src/
├── index.ts                  ← CLI entry point (commander)
├── hooks/
│   ├── hook-manager.ts       ← reads/writes ~/.claude/settings.json
│   └── hook-handler.ts       ← receives hook JSON from stdin, routes events
├── sessions/
│   ├── session-manager.ts    ← detects + tracks all active agent sessions
│   ├── session-watcher.ts    ← watches ~/.claude/projects/*.jsonl (chokidar)
│   └── tmux-bridge.ts        ← injects keystrokes into tmux panes (approve/deny)
├── tunnel/
│   ├── tunnel-manager.ts     ← manages cloudflared process
│   └── websocket-server.ts   ← local WS server that tunnel exposes
├── notifications/
│   └── ntfy-client.ts        ← sends push via ntfy.sh curl
├── crypto/
│   └── encryption.ts         ← TweetNaCl box encrypt/decrypt
├── relay/
│   └── relay-handler.ts      ← routes messages between phone and sessions
└── utils/
    ├── config.ts              ← reads/writes ~/.agentvigil/config.json
    ├── logger.ts              ← chalk-colored terminal output
    └── qr.ts                  ← generates QR code for terminal display
```

---

## Core Flow

### Setup (first run)
1. Check Node.js >= 18, check cloudflared installed (offer to install if not)
2. Register Claude Code hooks into `~/.claude/settings.json`
3. Generate X25519 keypair, save to `~/.agentvigil/keys.json`
4. Start local WebSocket server on port 3847
5. Start cloudflared tunnel → get public WSS URL
6. Build QR payload JSON → display QR in terminal
7. Wait for phone to scan and complete key exchange
8. Show "✅ Paired with AgentVigil" and save config

### Runtime (every session)
1. Claude Code fires a hook (Notification/Stop/SubagentStop)
2. hook-handler.ts receives JSON on stdin
3. Parses event → builds AgentEvent object
4. If phone is connected via WebSocket → encrypt + send
5. Always → send ntfy.sh push for background notification
6. If event is permission_prompt → wait for approve/deny from phone
7. On approve → tmux-bridge.ts injects 'y\n' into the session's tmux pane
8. On deny → tmux-bridge.ts injects 'n\n'

---

## Hook Registration

Hook commands write to `~/.claude/settings.json`. The hook CLI commands
receive structured JSON on stdin with these fields:
```typescript
interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;    // 'Notification' | 'Stop' | 'SubagentStop'
  notification_type?: string; // 'permission_prompt' | 'idle_prompt' | 'auth_success'
  message?: string;
}
```

Hooks to register:
```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [{ "type": "command", "command": "agentvigil hook permission_prompt" }]
      },
      {
        "matcher": "idle_prompt",
        "hooks": [{ "type": "command", "command": "agentvigil hook idle_prompt" }]
      }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "agentvigil hook stop" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "agentvigil hook subagent_stop" }] }
    ]
  }
}
```

IMPORTANT: Merge with existing hooks — never overwrite. Read existing
~/.claude/settings.json first, deep-merge, then write back.

---

## WebSocket Message Protocol

### Mac → Phone (events)
```typescript
interface AgentEvent {
  type: 'permission_prompt' | 'task_complete' | 'session_error' |
        'idle_waiting' | 'session_started' | 'session_ended' |
        'heartbeat' | 'full_sync';
  session_id: string;
  project_name: string;       // basename of cwd
  cwd: string;
  agent: 'claude-code' | 'codex' | 'amp';
  message: string;            // human-readable summary
  permission_command?: string; // set for permission_prompt events
  timestamp: string;          // ISO 8601
  pid?: string;
}

// full_sync sends entire session list
interface FullSyncEvent extends AgentEvent {
  type: 'full_sync';
  sessions: AgentEvent[];
}
```

### Phone → Mac (commands)
```typescript
interface PhoneCommand {
  type: 'approve' | 'deny' | 'send_prompt';
  session_id: string;
  payload?: string;            // prompt text for send_prompt
}
```

All messages are encrypted with TweetNaCl box before sending.
See .claude/skills/ENCRYPTION.md for the protocol.

---

## Config File (~/.agentvigil/config.json)
```typescript
interface Config {
  version: number;             // 1
  device_id: string;           // uuid v4, generated once
  ntfy_topic: string;          // random 32-char string, e.g. "agentvigil-x7k2m9p1..."
  paired_devices: PairedDevice[];
  ws_port: number;             // default 3847
  tunnel_url?: string;         // last known cloudflared URL
}

interface PairedDevice {
  name: string;                // e.g. "Pixel 8 Pro"
  device_id: string;
  public_key: string;          // base64 X25519 public key from phone
  shared_secret: string;       // base64, derived after pairing
  paired_at: string;           // ISO 8601
}
```

---

## Session Detection

Sessions are detected via THREE methods (use all three for reliability):

1. **tmux enumeration**: `tmux list-panes -a -F "#{pane_pid} #{pane_current_command} #{pane_current_path}"`
   Filter for panes running 'claude' or 'codex' or 'amp'

2. **JSONL watcher**: Watch `~/.claude/projects/` directory recursively with chokidar.
   Each project has a `*.jsonl` file. Parse last few lines to get session state.

3. **Hook events**: Most reliable — Claude Code tells us directly via hooks.
   Use this as the source of truth, JSONL as supplementary context.

---

## Tmux Keystroke Injection (Approve/Deny)

When phone sends approve/deny, inject into the correct tmux pane:

```typescript
// Find the pane by session_id (stored during session detection)
// Then inject:
exec(`tmux send-keys -t ${paneId} 'y' Enter`);  // approve
exec(`tmux send-keys -t ${paneId} 'n' Enter`);  // deny
```

IMPORTANT: If session is not in tmux (running directly in terminal),
fall back to sending a Mac notification: "Please approve in terminal: [project name]"

---

## ntfy.sh Push Format

```typescript
// Permission prompt (urgent — bypasses DND)
await fetch('https://ntfy.sh/' + config.ntfy_topic, {
  method: 'POST',
  headers: {
    'Title': `[${projectName}] Permission Required`,
    'Priority': 'urgent',
    'Tags': 'warning',
    'Click': 'agentvigil://session/' + sessionId,
  },
  body: permissionCommand,
});

// Task complete (default priority)
await fetch('https://ntfy.sh/' + config.ntfy_topic, {
  method: 'POST',
  headers: {
    'Title': `[${projectName}] Task Complete`,
    'Priority': 'default',
    'Tags': 'white_check_mark',
  },
  body: `Completed in ${duration}`,
});
```

---

## Cloudflared Setup

Check if cloudflared is installed:
```bash
which cloudflared || brew install cloudflared
```

Start tunnel:
```typescript
const proc = spawn('cloudflared', [
  'tunnel', '--url', `http://localhost:${config.ws_port}`,
  '--no-autoupdate'
]);

// Parse the tunnel URL from stdout:
// "Your quick Tunnel has been created! Visit it at: https://abc123.trycloudflare.com"
proc.stderr.on('data', (data) => {
  const match = data.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match) tunnelUrl = match[0].replace('https://', 'wss://');
});
```

The WSS URL goes into the QR code payload.

---

## QR Code Payload
```typescript
interface QrPayload {
  v: 1;                        // version
  wss: string;                 // e.g. "wss://abc123.trycloudflare.com"
  ntfy: string;                // ntfy topic name (not full URL)
  device_id: string;           // mac companion device ID
  pub_key: string;             // base64 X25519 public key
  expires: string;             // ISO 8601, 5 minutes from now
}
```

Display in terminal with qrcode-terminal package.

---

## Error Handling Rules

- Never crash the companion process on hook errors — always catch and log
- If cloudflared is not installed → print install instructions, continue without tunnel (ntfy only)
- If tmux is not running → skip keystroke injection, use Mac notification fallback
- If ntfy.sh is unreachable → log warning, continue (phone will get it via WS)
- If ~/.claude/settings.json is malformed → backup original, write fresh
- Always log with timestamps using logger.ts

---

## Key Commands Reference

```bash
npx agentvigil setup          # first-time setup
npx agentvigil start          # start daemon
npx agentvigil status         # print current session states
npx agentvigil hook <type>    # called by Claude Code hooks (stdin = JSON)
npx agentvigil unpair         # revoke all pairings
npx agentvigil logs           # tail the log file
npx agentvigil uninstall      # remove hooks from settings.json
```

---

## Skill Files

Read these before working on specific areas:

| File | When to read |
|---|---|
| `.claude/skills/HOOKS.md` | Before touching Claude Code hook registration |
| `.claude/skills/TUNNEL.md` | Before touching cloudflared or WebSocket server |
| `.claude/skills/SESSIONS.md` | Before touching session detection or tmux |
| `.claude/skills/ENCRYPTION.md` | Before touching crypto or pairing |
| `.claude/skills/NOTIFICATIONS.md` | Before touching ntfy.sh push |
| `.claude/skills/TESTING.md` | Before writing tests |

---

## What NOT To Do

- ❌ Never require a server — zero backend, zero cost
- ❌ Never store session content anywhere permanently
- ❌ Never overwrite ~/.claude/settings.json — always merge
- ❌ Never crash on hook errors — log and continue
- ❌ Never use console.log — use logger.ts
- ❌ Never hardcode the ntfy topic or device ID — always read from config
- ❌ Never block the main process — all I/O is async
- ❌ Never require sudo — everything runs as the current user
