import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getBridgeDbPath, loadBridgeSession } from "./linkage";
import { PROVIDER_ID } from "./models";
import type { BridgeRuntime } from "./runtime";

const require = createRequire(import.meta.url);
const BRIDGE_PACKAGE_PATH = new URL("./package.json", import.meta.url);

export type DoctorSeverity = "ok" | "warning" | "fatal";
export type BridgeSourceKind = "local" | "git" | "npm" | "other";

interface SettingsSnapshot {
  path: string;
  parsed: any;
}

export interface DuplicateInstallOccurrence {
  source: string;
  kind: BridgeSourceKind;
  scope: "packages" | "extensions";
  settingsFile: string;
}

export interface DuplicateInstallReport {
  occurrences: DuplicateInstallOccurrence[];
  sources: string[];
  settingsFiles: string[];
  severity: DoctorSeverity;
  summary: string;
  fixLines: string[];
}

interface DoctorCheck {
  name: string;
  severity: DoctorSeverity;
  detail: string;
}

function tryParseJson(path: string): any {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function loadSettingsSnapshots(cwd: string): SettingsSnapshot[] {
  const paths = [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(cwd, ".pi", "settings.json"),
  ];
  const snapshots: SettingsSnapshot[] = [];
  for (const path of paths) {
    const parsed = tryParseJson(path);
    if (!parsed) continue;
    snapshots.push({ path, parsed });
  }
  return snapshots;
}

function classifySource(source: string): BridgeSourceKind {
  if (source.startsWith("git:")) return "git";
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith(".") || source.startsWith("/") || isAbsolute(source)) return "local";
  return "other";
}

function normalizeSource(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (typeof (entry as any)?.source === "string") return (entry as any).source;
  return null;
}

function extractPiCcBridgeOccurrences(settings: any, settingsFile: string): DuplicateInstallOccurrence[] {
  const occurrences: DuplicateInstallOccurrence[] = [];
  const scopes: Array<{ key: "packages" | "extensions"; values: unknown[] }> = [
    { key: "packages", values: Array.isArray(settings?.packages) ? settings.packages : [] },
    { key: "extensions", values: Array.isArray(settings?.extensions) ? settings.extensions : [] },
  ];

  for (const scope of scopes) {
    for (const entry of scope.values) {
      const source = normalizeSource(entry);
      if (!source || !/pi-cc-bridge/i.test(source)) continue;
      occurrences.push({
        source,
        kind: classifySource(source),
        scope: scope.key,
        settingsFile,
      });
    }
  }

  return occurrences;
}

function severityRank(severity: DoctorSeverity) {
  return severity === "fatal" ? 2 : severity === "warning" ? 1 : 0;
}

function maxSeverity(...levels: DoctorSeverity[]): DoctorSeverity {
  return levels.reduce<DoctorSeverity>((best, current) => severityRank(current) > severityRank(best) ? current : best, "ok");
}

function readJsonVersion(path: string | URL): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function resolvePackageVersion(specifier: string): string | null {
  try {
    const packageJsonPath = require.resolve(`${specifier}/package.json`);
    return readJsonVersion(packageJsonPath);
  } catch {
    return null;
  }
}

function renderLines(lines: string[]) {
  return `${lines.join("\n")}\n`;
}

function writePrintOutput(lines: string[]) {
  writeSync(1, renderLines(lines));
}

function trimLine(text: string | null | undefined) {
  return text?.trim() || "";
}

function checkNodeVersion(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return {
    name: "node",
    severity: major >= 20 ? "ok" : "fatal",
    detail: process.version,
  };
}

function checkSqlitePath(): DoctorCheck {
  const dbPath = getBridgeDbPath();
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    accessSync(dirname(dbPath), constants.W_OK);
    return { name: "sqlite", severity: "ok", detail: `${dbPath} writable` };
  } catch (error) {
    return {
      name: "sqlite",
      severity: "fatal",
      detail: `cannot write ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function checkClaudeCli(): DoctorCheck {
  const command = spawnSync("claude", ["auth", "status"], {
    encoding: "utf-8",
    timeout: 5000,
  });

  if (command.error) {
    return {
      name: "claudeAuth",
      severity: "fatal",
      detail: (command.error as NodeJS.ErrnoException).code === "ENOENT"
        ? "claude CLI not found in PATH"
        : command.error.message,
    };
  }

  const stdout = trimLine(command.stdout);
  const stderr = trimLine(command.stderr);
  if (command.status !== 0) {
    return {
      name: "claudeAuth",
      severity: "fatal",
      detail: stderr || stdout || `claude auth status exited ${command.status}`,
    };
  }

  if (stdout.startsWith("{")) {
    try {
      const parsed = JSON.parse(stdout);
      const loggedIn = parsed?.loggedIn === true;
      return {
        name: "claudeAuth",
        severity: loggedIn ? "ok" : "fatal",
        detail: loggedIn
          ? `loggedIn=true authMethod=${parsed?.authMethod ?? "unknown"} subscription=${parsed?.subscriptionType ?? "unknown"}`
          : "loggedIn=false",
      };
    } catch {
      // fall through
    }
  }

  return {
    name: "claudeAuth",
    severity: /logged.?in|active|ok/i.test(stdout) ? "ok" : "warning",
    detail: stdout || "status returned non-JSON output",
  };
}

function checkDefaultProvider(settingsSnapshots: SettingsSnapshot[]): DoctorCheck {
  const configured = settingsSnapshots
    .filter((snapshot) => typeof snapshot.parsed?.defaultProvider === "string")
    .map((snapshot) => `${snapshot.path} -> ${snapshot.parsed.defaultProvider}`);

  if (configured.length === 0) {
    return {
      name: "defaultProvider",
      severity: "warning",
      detail: `no defaultProvider configured; set ${PROVIDER_ID} if you want Claude by default`,
    };
  }

  const matching = configured.filter((line) => line.endsWith(`-> ${PROVIDER_ID}`));
  if (matching.length > 0) {
    return {
      name: "defaultProvider",
      severity: "ok",
      detail: matching.join(" | "),
    };
  }

  return {
    name: "defaultProvider",
    severity: "warning",
    detail: configured.join(" | "),
  };
}

export function findDuplicateBridgeInstalls(cwd: string): DuplicateInstallReport {
  const settingsSnapshots = loadSettingsSnapshots(cwd);
  const occurrences = settingsSnapshots.flatMap((snapshot) => extractPiCcBridgeOccurrences(snapshot.parsed, snapshot.path));
  const sources = [...new Set(occurrences.map((entry) => entry.source))];
  const settingsFiles = [...new Set(occurrences.map((entry) => entry.settingsFile))];
  const severity: DoctorSeverity = occurrences.length <= 1 ? "ok" : "fatal";
  const summary = severity === "ok"
    ? `${occurrences.length} configured bridge source`
    : `${occurrences.length} bridge entries detected across ${settingsFiles.length} settings file(s)`;

  const fixLines = severity === "ok"
    ? []
    : [
        "keep exactly one pi-cc-bridge source active",
        ...occurrences.map((entry) => `remove one of: ${entry.settingsFile} -> ${entry.scope}: ${entry.source}`),
      ];

  return {
    occurrences,
    sources,
    settingsFiles,
    severity,
    summary,
    fixLines,
  };
}

export function getStartupHealth(cwd: string) {
  const duplicates = findDuplicateBridgeInstalls(cwd);
  if (duplicates.severity === "fatal") {
    return {
      severity: "fatal" as const,
      text: `pi-cc-bridge doctor: ${duplicates.summary}`,
      notify: `pi-cc-bridge duplicate installs detected. Run /pi-cc-bridge-doctor`,
    };
  }

  return {
    severity: "ok" as const,
    text: undefined,
    notify: undefined,
  };
}

export function assertNoFatalDuplicateInstall(cwd: string) {
  const duplicates = findDuplicateBridgeInstalls(cwd);
  if (duplicates.severity !== "fatal") return;
  const detail = [
    `pi-cc-bridge refused to run: ${duplicates.summary}`,
    ...duplicates.fixLines,
  ].join("\n");
  throw new Error(detail);
}

function formatCheck(check: DoctorCheck) {
  return `  - ${check.name}: ${check.severity} — ${check.detail}`;
}

export async function buildBridgeStatus(runtime: BridgeRuntime, ctx: ExtensionCommandContext, extensionDir: string) {
  const piSessionId = runtime.currentPiSessionId ?? ctx.sessionManager.getSessionId();
  const cwd = runtime.currentCwd ?? ctx.sessionManager.getCwd();
  const persisted = await loadBridgeSession(piSessionId ?? undefined);
  const duplicates = findDuplicateBridgeInstalls(cwd);
  const bridgeVersion = readJsonVersion(BRIDGE_PACKAGE_PATH) ?? "unknown";
  const piVersion = resolvePackageVersion("@mariozechner/pi-coding-agent") ?? "unknown";

  const lines = [
    `provider: ${PROVIDER_ID}`,
    `bridgeVersion: ${bridgeVersion}`,
    `piVersion: ${piVersion}`,
    `nodeVersion: ${process.version}`,
    `extensionDir: ${extensionDir}`,
    `cwd: ${cwd}`,
    `piSessionId: ${piSessionId ?? "(none)"}`,
    `model: ${ctx.model?.id ?? "(none)"}`,
    `runtimeSharedSession: ${runtime.sharedSession?.sessionId ?? "(none)"}`,
    `runtimeSharedCursor: ${runtime.sharedSession?.cursor ?? 0}`,
    `sqliteDb: ${getBridgeDbPath()}`,
    `sqliteLinkedClaudeSession: ${persisted?.liveClaudeSessionId ?? "(none)"}`,
    `sqliteCursor: ${persisted?.liveCursor ?? 0}`,
    `sqliteState: ${persisted?.state ?? "(none)"}`,
    `duplicateInstallSeverity: ${duplicates.severity}`,
    `duplicateInstallCount: ${duplicates.occurrences.length}`,
  ];

  if (duplicates.occurrences.length) {
    lines.push("duplicateInstallEntries:");
    for (const entry of duplicates.occurrences) {
      lines.push(`  - ${entry.settingsFile} -> ${entry.scope}: ${entry.source}`);
    }
  }

  return lines;
}

export async function buildBridgeDoctor(runtime: BridgeRuntime, ctx: ExtensionCommandContext, extensionDir: string) {
  const cwd = runtime.currentCwd ?? ctx.sessionManager.getCwd();
  const duplicates = findDuplicateBridgeInstalls(cwd);
  const settingsSnapshots = loadSettingsSnapshots(cwd);

  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    checkSqlitePath(),
    checkClaudeCli(),
    checkDefaultProvider(settingsSnapshots),
    {
      name: "duplicates",
      severity: duplicates.severity,
      detail: duplicates.summary,
    },
  ];

  const doctorStatus = checks.reduce<DoctorSeverity>((best, check) => maxSeverity(best, check.severity), "ok");
  const lines = [
    `doctorStatus: ${doctorStatus}`,
    `provider: ${PROVIDER_ID}`,
    `extensionDir: ${extensionDir}`,
    `cwd: ${cwd}`,
    "checks:",
    ...checks.map(formatCheck),
  ];

  if (duplicates.fixLines.length) {
    lines.push("fixes:");
    for (const fix of duplicates.fixLines) lines.push(`  - ${fix}`);
  }

  return lines;
}

export async function showCommandOutput(title: string, lines: string[], ctx: ExtensionCommandContext) {
  if (ctx.hasUI) {
    await ctx.ui.select(title, lines);
    return;
  }
  writePrintOutput(lines);
}
