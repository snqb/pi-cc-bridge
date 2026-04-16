# pi-cc-bridge

**Claude Code as engine. Pi as host.**

`pi-cc-bridge` lets you use Claude from Pi through your existing Claude Code setup.

Claude Code remains the authenticated path. Pi remains the host, tool runner, and session manager.

The result is simple: you keep Pi’s tools, workflows, and extensibility, while Claude handles the reasoning.

## Install

Global install:

```bash
pi install git:https://github.com/snqb/pi-cc-bridge
```

Project-local install:

```bash
pi install -l git:https://github.com/snqb/pi-cc-bridge
```

One-off test without installing:

```bash
pi -e git:https://github.com/snqb/pi-cc-bridge --provider pi-cc-bridge
```

If you want Claude to be the default for Pi, set this in your settings:

```json
{
  "defaultProvider": "pi-cc-bridge"
}
```

Start a fresh Pi process after installing or changing the default provider.

## Why this exists

`pi-cc-bridge` takes a conservative route to Claude integration.

Instead of replacing Claude Code auth or relying on unofficial session hacks, it uses your existing Claude Code setup and lets Pi provide the outer orchestration layer.

This became more useful as Claude access patterns shifted and external integrations became less predictable for some users. If you want Pi’s tools and workflow without leaving the Claude Code path, this bridge exists for that gap.

Further reading:

- Claude Code overview: https://docs.anthropic.com/en/docs/claude-code/overview
- Public Claude Code auth/access issue: https://github.com/anthropics/claude-code/issues/6687
- Another public login/access thread: https://github.com/anthropics/claude-code/issues/45886

## Authentication

`pi-cc-bridge` does **not** add a separate Pi-side login flow.

Authenticate Claude Code itself, then Pi will reuse that auth:

```bash
claude auth login
claude auth status
```

In practice:

- log in with the `claude` CLI, not through a special `/login` flow in Pi
- once `claude auth status` looks good, `pi-cc-bridge` can use that session
- if Claude Code is logged out, the bridge cannot talk to Claude

## What it does

- uses Claude through the Claude Agent SDK
- keeps Pi-side tools working: `read`, `bash`, `edit`, `write`, memory, browser, subagents, interactive shell, custom tools
- keeps Pi as the host, tool runner, and orchestration layer
- supports both normal follow-ups and fresh-process Pi session resume

## How it works

There are two continuation paths:

- **same live Pi process**: reuses the real Claude session when possible
- **fresh Pi process / resumed Pi session**: rebuilds prior Pi context into a compact replay prompt and continues from that

This is intentional. It keeps Pi resume reliable without depending on fragile fabricated Claude session IDs.

## Scope

This package is for people who want:

- Claude quality
- Pi tools
- Pi orchestration
- a focused Pi-style workflow

It is not trying to reproduce Claude Code exactly.

## Debug

Optional:

```bash
PI_CC_BRIDGE_DEBUG=1
```

Logs:

- `~/.pi/agent/pi-cc-bridge.log`
- `~/.pi/agent/pi-cc-bridge-diag.log`

Commands:

```text
/pi-cc-bridge-status
/pi-cc-bridge-doctor
/pi-cc-bridge-report [days]
/pi-cc-bridge-cleanup
```

Print mode also works:

```bash
pi -p "/pi-cc-bridge-status"
pi -p "/pi-cc-bridge-doctor"
pi -p "/pi-cc-bridge-report 7"
pi -p "/pi-cc-bridge-cleanup"
```

## Smoke test

```bash
npm run smoke
```

## Troubleshooting

If the bridge acts weird, check these first:

- run `/pi-cc-bridge-doctor`
- run `/pi-cc-bridge-report 7` to see recent sessions, errors, and 5xx counts
- make sure only one `pi-cc-bridge` source is installed
- confirm `claude auth status`
- make sure `defaultProvider` is `pi-cc-bridge` if that is what you want
- run `/pi-cc-bridge-cleanup` if you want to prune stale linkage rows
- rerun `npm run smoke`

## Credits

Built on top of:

- [Pi](https://github.com/mariozechner/pi-coding-agent) — the host agent, tool system, and extension runtime
- [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai) — Pi model/provider interfaces
- [Anthropic Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — Claude-side agent/session/runtime layer
- [Anthropic SDK](https://www.npmjs.com/package/@anthropic-ai/sdk) — API types and client primitives
- [elidickinson/pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) — earlier bridge work that helped inform this direction

This bridge exists to connect those pieces into a Pi-native Claude provider.
