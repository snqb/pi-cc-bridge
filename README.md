# pi-cc-bridge

`pi-cc-bridge` lets Pi use Claude as the model engine without giving up the normal Pi workflow.

Pi stays in charge. Pi tools stay real. Claude does the reasoning.

## What it does

- uses Claude through the Claude Agent SDK
- keeps Pi-side tools working: `read`, `bash`, `edit`, `write`, memory, browser, subagents, interactive shell, custom tools
- keeps the default feel closer to Pi than to Claude Code
- supports normal follow-ups and fresh-process session resume

## How it works

There are two continuation paths:

- **same live Pi process**: reuses the real Claude session when possible
- **fresh Pi process / resumed Pi session**: rebuilds prior Pi context into a compact replay prompt and continues from that

That second path is intentional. It avoids brittle fake Claude session IDs and makes Pi resume reliably.

## Install

If you manage Pi extensions locally, put this folder under:

```bash
~/.pi/agent/extensions/pi-cc-bridge
```

Then add it to `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "pi-cc-bridge",
  "packages": [
    "./extensions/pi-cc-bridge"
  ]
}
```

Or keep your existing package list and just add the extension path.

After that, start a fresh Pi process.

## Scope

This bridge is for people who want:

- Claude quality
- Pi tools
- Pi orchestration
- a more focused Pi-style workflow

It is **not** trying to reproduce Claude Code exactly.

## Debug

Optional:

```bash
PI_CC_BRIDGE_DEBUG=1
```

Logs:

- `~/.pi/agent/pi-cc-bridge.log`
- `~/.pi/agent/pi-cc-bridge-diag.log`
