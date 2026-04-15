import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getBridgeDbPath, loadBridgeSession } from "./linkage";
import type { BridgeRuntime } from "./runtime";

interface DuplicateInstallReport {
  sources: string[];
  settingsFiles: string[];
}

function tryParseJson(path: string): any {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function extractPiCcBridgeSources(settings: any): string[] {
  const packages = Array.isArray(settings?.packages) ? settings.packages : [];
  const sources: string[] = [];
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : typeof entry?.source === "string" ? entry.source : null;
    if (!source) continue;
    if (/pi-cc-bridge/i.test(source)) sources.push(source);
  }
  return sources;
}

export function findDuplicateBridgeInstalls(cwd: string): DuplicateInstallReport {
  const settingsPaths = [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(cwd, ".pi", "settings.json"),
  ];
  const sources = new Set<string>();
  const settingsFiles: string[] = [];
  for (const path of settingsPaths) {
    const parsed = tryParseJson(path);
    if (!parsed) continue;
    const found = extractPiCcBridgeSources(parsed);
    if (!found.length) continue;
    settingsFiles.push(path);
    for (const source of found) sources.add(source);
  }
  return {
    sources: [...sources],
    settingsFiles,
  };
}

export async function buildBridgeStatus(runtime: BridgeRuntime, ctx: ExtensionCommandContext, extensionPath: string) {
  const piSessionId = runtime.currentPiSessionId ?? ctx.sessionManager.getSessionId();
  const cwd = runtime.currentCwd ?? ctx.sessionManager.getCwd();
  const persisted = await loadBridgeSession(piSessionId ?? undefined);
  const duplicates = findDuplicateBridgeInstalls(cwd);
  const lines = [
    `provider: pi-cc-bridge`,
    `extension: ${extensionPath}`,
    `cwd: ${cwd}`,
    `piSessionId: ${piSessionId ?? "(none)"}`,
    `model: ${ctx.model?.id ?? "(none)"}`,
    `runtimeSharedSession: ${runtime.sharedSession?.sessionId ?? "(none)"}`,
    `runtimeSharedCursor: ${runtime.sharedSession?.cursor ?? 0}`,
    `sqliteDb: ${getBridgeDbPath()}`,
    `sqliteLinkedClaudeSession: ${persisted?.liveClaudeSessionId ?? "(none)"}`,
    `sqliteCursor: ${persisted?.liveCursor ?? 0}`,
    `sqliteState: ${persisted?.state ?? "(none)"}`,
    `duplicateInstallCount: ${duplicates.sources.length}`,
  ];

  if (duplicates.sources.length) {
    lines.push("duplicateInstallSources:");
    for (const source of duplicates.sources) lines.push(`  - ${source}`);
  }
  if (duplicates.settingsFiles.length) {
    lines.push("settingsFiles:");
    for (const file of duplicates.settingsFiles) lines.push(`  - ${file}`);
  }

  return lines;
}
