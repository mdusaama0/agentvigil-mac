# AgentVigil

Never babysit a stuck AI coding session again.

## What it does

AgentVigil watches your AI coding agents (Claude Code, Codex, Amp) for permission prompts, idle states, and completions, then pushes an encrypted notification to your phone the moment one needs your attention. Approve or deny right from the lock screen — no need to keep checking your terminal.

<!-- screenshot here -->

## How it works

```
Claude Code  →  hooks  →  AgentVigil companion  →  Cloudflare Tunnel  →  AgentVigil app (Android / iOS)
```

The companion runs quietly on your Mac, picks up hook events the instant they fire, encrypts them end-to-end, and relays them through a Cloudflare Tunnel to your phone. Replies (approve/deny) make the same trip in reverse.

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js >= 18
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`brew install cloudflared`)
- AgentVigil app — [Android (Google Play)](https://play.google.com/store/apps/details?id=com.stacktree.agentvigil) · iOS (coming soon)

## Quick Start

```bash
npx agentvigil setup
```

```bash
npx agentvigil start
```

## Enabling Approve/Deny (macOS Accessibility permission)

Tapping **Approve**/**Deny** on your phone works by typing `1`/`3` + Enter into your terminal for you. On macOS, that requires the **Accessibility** permission — without it, you'll still get the push notification, but you'll see `Terminal.app: missing Accessibility permission for keystroke injection` in the logs and a fallback Mac notification telling you to type the key yourself.

To enable it:

1. Open **System Settings → Privacy & Security → Accessibility**.
2. Find **Terminal** in the list (or whichever app your terminal window belongs to — iTerm2, etc.) and toggle it **on**.
   - If it's not in the list, click **+** and add it from `/System/Applications/Utilities/Terminal.app` (or `/Applications/iTerm.app`).
3. Restart the AgentVigil daemon (`npx agentvigil setup` / `npx agentvigil start`).
4. Trigger a permission prompt and try Approve/Deny from your phone again.

If you toggle the switch but it still doesn't work, remove the entry (select it, click **-**) and add it again — macOS sometimes needs the permission re-granted after a new process starts using it.

## Commands

| Command | Description |
|---|---|
| `agentvigil setup` | First-time setup: register hooks and pair with mobile app |
| `agentvigil start` | Start the AgentVigil daemon |
| `agentvigil status` | Show all active agent sessions |
| `agentvigil logs` | Tail the AgentVigil log file |
| `agentvigil unpair` | Revoke mobile app pairing |
| `agentvigil uninstall` | Remove AgentVigil hooks from Claude Code and Codex |
| `agentvigil install-autostart` | Start AgentVigil automatically on login |
| `agentvigil uninstall-autostart` | Remove autostart |

## Supported Agents

| Agent | Session Detection | Push Notifications | Approve/Deny |
|---|---|---|---|
| Claude Code | ✅ | ✅ | ✅ |
| Codex CLI | ✅ | ✅ (coming soon) | ✅ (coming soon) |
| Amp | ✅ | 🔜 | 🔜 |

## Security

- **End-to-end encrypted** — every message between your Mac and phone is encrypted with TweetNaCl (XSalsa20-Poly1305).
- **Zero server storage** — there is no AgentVigil backend. Nothing about your sessions is ever stored on a server.
- **Cloudflare Tunnel, no open ports** — your Mac is never directly reachable from the internet.
- **Session content stays local** — prompts, code, and terminal output never leave your Mac except as encrypted relay traffic to your own paired phone.

Audit this code — it's all here.

## Why open source?

AgentVigil runs as a daemon with access to your AI coding sessions and your terminal. That's a lot of trust to ask for, so the code that earns it should be inspectable by anyone. Open source lets you (or anyone) verify exactly what data is read, what gets encrypted, and where it goes before you let it run on your machine.

## Contributing

Issues and PRs welcome.

## License

MIT
