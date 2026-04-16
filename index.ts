import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadBridgeSession, persistBridgeSessionLink, touchBridgeSession, clearBridgeSessionLink } from "./linkage";
import { loadConfig } from "./config";
import { setDebug, debug } from "./logging";
import { MODELS, PROVIDER_ID } from "./models";
import { BridgeRuntime } from "./runtime";
import { createProvider } from "./provider";
import { buildBridgeDoctor, buildBridgeStatus, getStartupHealth, showCommandOutput } from "./status";

function readPiSessionId(sessionFile?: string): string | undefined {
  if (!sessionFile) return undefined;
  try {
    const firstLine = readFileSync(sessionFile, "utf-8").split("\n", 1)[0];
    if (!firstLine) return undefined;
    const header = JSON.parse(firstLine);
    return typeof header?.id === "string" ? header.id : undefined;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig(process.cwd());
  setDebug(Boolean(config.debug));
  const runtime = new BridgeRuntime();
  const extensionDir = dirname(fileURLToPath(import.meta.url));
  let startupWarningShown = false;

  debug("loading", { provider: PROVIDER_ID, profile: config.behaviorProfile });

  pi.on("session_shutdown", async () => {
    runtime.abortActiveRun("Session shutting down");
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "new" || event.reason === "fork") {
      runtime.abortActiveRun("Session changed");
    }
    const piSessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.sessionManager.getCwd();
    runtime.currentPiSessionId = piSessionId;
    runtime.currentCwd = cwd;

    const startupHealth = getStartupHealth(cwd);
    if (ctx.hasUI) ctx.ui.setStatus("pi-cc-bridge", startupHealth.text);
    if (ctx.hasUI && !startupWarningShown && startupHealth.notify) {
      startupWarningShown = true;
      ctx.ui.notify(startupHealth.notify, startupHealth.severity === "fatal" ? "error" : "warning");
    }

    if (event.reason === "resume") {
      const previousPiSessionId = readPiSessionId(event.previousSessionFile);
      if (previousPiSessionId && previousPiSessionId !== piSessionId) {
        const previous = await loadBridgeSession(previousPiSessionId);
        if (previous?.liveClaudeSessionId) {
          await persistBridgeSessionLink({
            piSessionId,
            cwd,
            provider: PROVIDER_ID,
            model: previous.model ?? "",
            liveClaudeSessionId: previous.liveClaudeSessionId,
            liveCursor: previous.liveCursor,
            state: previous.state,
          });
        }
      }
    }

    await touchBridgeSession(piSessionId, cwd, PROVIDER_ID, "");
    const persisted = await loadBridgeSession(piSessionId);
    if (persisted?.state === "waiting_tool_results") {
      runtime.clearSharedSession();
      await clearBridgeSessionLink(piSessionId);
    } else if (persisted?.liveClaudeSessionId && persisted.cwd === cwd) {
      runtime.sharedSession = {
        sessionId: persisted.liveClaudeSessionId,
        cursor: persisted.liveCursor,
        cwd: persisted.cwd,
      };
    } else {
      runtime.clearSharedSession();
    }
  });

  pi.registerCommand("pi-cc-bridge-status", {
    description: "Show pi-cc-bridge session/linkage status",
    handler: async (_args, ctx) => {
      const lines = await buildBridgeStatus(runtime, ctx, extensionDir);
      await showCommandOutput("pi-cc-bridge status", lines, ctx);
    },
  });

  pi.registerCommand("pi-cc-bridge-doctor", {
    description: "Run pi-cc-bridge health checks",
    handler: async (_args, ctx) => {
      const lines = await buildBridgeDoctor(runtime, ctx, extensionDir);
      await showCommandOutput("pi-cc-bridge doctor", lines, ctx);
    },
  });

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: PROVIDER_ID,
    apiKey: "not-used",
    api: "anthropic" as any,
    models: MODELS,
    streamSimple: createProvider(runtime, config) as any,
  });
}
