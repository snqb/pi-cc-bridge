# pi-cc-bridge

`pi-cc-bridge` lets Pi use Claude as the model engine without giving up the normal Pi workflow.

Pi stays in charge. Pi tools stay real. Claude does the reasoning.

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

## What it does

- uses Claude through the Claude Agent SDK
- keeps Pi-side tools working: `read`, `bash`, `edit`, `write`, memory, browser, subagents, interactive shell, custom tools
- keeps the default feel closer to Pi than to Claude Code
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
