# Contributing to AgentVigil

Thanks for your interest in improving AgentVigil! This is the Mac companion CLI — it pairs with the AgentVigil mobile app to surface Claude Code / Codex / Amp session events on your phone.

## Getting set up

```bash
git clone https://github.com/mdusaama0/agentvigil-mac.git
cd agentvigil-mac
npm install
```

Useful scripts during development:

```bash
npm run dev     # run the CLI from source with tsx (no build step)
npm run build   # compile src/ → dist/ with tsc
npm test        # run the vitest suite
npm run lint    # run eslint over src/
```

## Before opening a PR

Make sure these all pass:

```bash
npm run build
npm test
npm run lint
```

## Guidelines

- **No telemetry, analytics, or calls to any AgentVigil-owned server.** This project is explicitly zero-server — see the [Security](README.md#security) section of the README for why.
- **Nothing is written outside `~/.agentvigil/`.** Config, keys, and logs all live there.
- Keep PRs focused — one fix or feature per PR is easier to review.
- Add or update tests in `src/**/__tests__/` for any behavioral change.
- Follow the existing code style (the lint step will catch most issues).

## Reporting issues

Open a [GitHub issue](https://github.com/mdusaama0/agentvigil-mac/issues) with steps to reproduce, your macOS version, and Node.js version (`node -v`).
