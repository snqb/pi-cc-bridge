import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config";
import { setDebug, debug } from "./logging";
import { MODELS, PROVIDER_ID } from "./models";
import { BridgeRuntime } from "./runtime";
import { createProvider } from "./provider";

export default function (pi: ExtensionAPI) {
  const config = loadConfig(process.cwd());
  setDebug(Boolean(config.debug));
  const runtime = new BridgeRuntime();

  debug("loading", { provider: PROVIDER_ID, profile: config.behaviorProfile });

  pi.on("session_shutdown", async () => {
    runtime.abortActiveRun("Session shutting down");
  });

  pi.on("session_start", async (event) => {
    if (event.reason === "new" || event.reason === "fork") {
      runtime.abortActiveRun("Session changed");
    }
  });

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: PROVIDER_ID,
    apiKey: "not-used",
    api: "anthropic" as any,
    models: MODELS,
    streamSimple: createProvider(runtime, config) as any,
  });
}
