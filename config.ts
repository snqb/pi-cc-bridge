import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BehaviorProfile = "vanilla" | "hybrid" | "claude";

export interface BridgeConfig {
  behaviorProfile?: BehaviorProfile;
  debug?: boolean;
}

function tryParseJson(path: string): Partial<BridgeConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

export function loadConfig(cwd: string): BridgeConfig {
  const global = tryParseJson(join(homedir(), ".pi", "agent", "pi-cc-bridge.json"));
  const project = tryParseJson(join(cwd, ".pi", "pi-cc-bridge.json"));
  return {
    behaviorProfile: project.behaviorProfile ?? global.behaviorProfile ?? "vanilla",
    debug: project.debug ?? global.debug ?? false,
  };
}
