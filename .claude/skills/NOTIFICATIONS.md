# SKILL: Push Notifications via ntfy.sh
# Read before touching notifications/ntfy-client.ts

## Why ntfy.sh
- Free, open source, no account required
- Works via a secret topic name (like a password-protected channel)
- Supports priority, tags, titles, click actions
- Android app available on Play Store (free)
- iOS app available on App Store (free)
- AgentVigil Flutter app subscribes to the topic directly

## Topic Generation
Generate a unique, hard-to-guess topic on first setup:
```typescript
import { randomBytes } from 'crypto';
const topic = 'agentvigil-' + randomBytes(16).toString('hex');
// e.g. "agentvigil-a3f2b1c8d4e5f6a7b8c9d0e1f2a3b4c5"
```
Store in ~/.agentvigil/config.json as ntfy_topic.
Include in QR code so the phone knows which topic to subscribe to.

## Sending Notifications
```typescript
// src/notifications/ntfy-client.ts
import fetch from 'node-fetch';

const NTFY_BASE = 'https://ntfy.sh';

export async function sendPermissionNotification(
  topic: string,
  projectName: string,
  command: string,
  sessionId: string
): Promise<void> {
  await fetch(`${NTFY_BASE}/${topic}`, {
    method: 'POST',
    headers: {
      'Title': `[${projectName}] Permission Required ⚠️`,
      'Priority': 'urgent',
      'Tags': 'warning,rotating_light',
      'Click': `agentvigil://session/${sessionId}`,
      'Actions': `http, APPROVE, https://ntfy.sh/${topic}/approve/${sessionId}; http, DENY, https://ntfy.sh/${topic}/deny/${sessionId}`,
    },
    body: command,
  }).catch(err => logger.warn('ntfy push failed (offline?)', err));
}

export async function sendTaskCompleteNotification(
  topic: string,
  projectName: string,
  duration: string
): Promise<void> {
  await fetch(`${NTFY_BASE}/${topic}`, {
    method: 'POST',
    headers: {
      'Title': `[${projectName}] Task Complete ✓`,
      'Priority': 'default',
      'Tags': 'white_check_mark',
    },
    body: `Completed in ${duration}`,
  }).catch(err => logger.warn('ntfy push failed', err));
}

export async function sendErrorNotification(
  topic: string,
  projectName: string,
  error: string
): Promise<void> {
  await fetch(`${NTFY_BASE}/${topic}`, {
    method: 'POST',
    headers: {
      'Title': `[${projectName}] Session Error`,
      'Priority': 'high',
      'Tags': 'x,red_circle',
    },
    body: error,
  }).catch(err => logger.warn('ntfy push failed', err));
}
```

## Priority Levels
- `urgent` — bypasses DND on Android/iOS (use for permission_prompt only)
- `high` — high priority (use for errors)
- `default` — normal (use for task complete, idle)
- `low` — background (use for session started)

## ntfy Tags (renders as emoji in notification)
- `warning` → ⚠️
- `white_check_mark` → ✅
- `x` → ❌
- `rotating_light` → 🚨
- `information_source` → ℹ️

## Always Send ntfy Even When Phone is Connected via WS
Send BOTH the WebSocket event AND the ntfy push for every important event.
Reason: WebSocket might drop without us knowing. ntfy is the safety net.
```typescript
// In relay-handler.ts:
wsServer.sendEvent(event);       // live update if connected
await ntfy.send(event);          // push safety net always
```

## Mac Notification Fallback (when ntfy fails)
```typescript
// Fallback for approve/deny when tmux not available
import { exec } from 'child_process';
exec(`osascript -e 'display notification "${message}" with title "AgentVigil" sound name "Funk"'`);
```
