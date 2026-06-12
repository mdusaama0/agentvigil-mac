# AgentVigil Mac Companion

The bridge between Claude Code on your Mac and the AgentVigil mobile app.

**Zero server. Zero cost. Just your Mac and your phone.**

```
Claude Code hooks → Mac Companion → Cloudflare Tunnel → AgentVigil App
                                 → ntfy.sh push       → Phone notification
```

---

## Install

```bash
npm install -g agentvigil
agentvigil setup
```

Or without installing:
```bash
npx agentvigil setup
```

## Requirements
- Node.js >= 18
- macOS (Apple Silicon or Intel)
- tmux (recommended for approve/deny)
- cloudflared (`brew install cloudflared`)

---

## Commands

```bash
agentvigil setup      # first-time: register hooks, generate keys, show QR
agentvigil start      # start daemon
agentvigil status     # show active sessions
agentvigil logs       # tail log file
agentvigil unpair     # revoke device pairing
agentvigil uninstall  # remove hooks from Claude Code
```

---

## How It Works

1. `setup` registers hooks in `~/.claude/settings.json`
2. Starts a local WebSocket server + cloudflared tunnel
3. Shows a QR code — scan with AgentVigil app on your phone
4. When Claude Code hits a permission prompt, the hook fires
5. Mac companion sends encrypted push to your phone via ntfy.sh
6. You tap Approve/Deny → Mac injects the keystroke into tmux

---

## Architecture

```
src/
├── index.ts              ← CLI (commander)
├── hooks/                ← Claude Code hook registration + handler
├── sessions/             ← Session detection (tmux + JSONL watcher)
├── tunnel/               ← cloudflared + WebSocket server
├── notifications/        ← ntfy.sh push client
├── crypto/               ← TweetNaCl encryption + pairing
├── relay/                ← Routes messages between phone and sessions
└── utils/                ← Config, logger, QR code
```

Read `CLAUDE.md` and `.claude/skills/` before making changes.

---

## License
MIT
