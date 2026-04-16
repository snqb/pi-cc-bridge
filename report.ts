import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER_ID } from "./models";

const SESSION_ROOT = join(homedir(), ".pi", "agent", "sessions");
const DIAG_PATH = join(homedir(), ".pi", "agent", "pi-cc-bridge-diag.log");

const LEGACY_INTERNAL_ERROR_TEXTS = [
  "Bridge expected a user message to start a query.",
  "Bridge was waiting for tool results but none were provided.",
];

const CURRENT_INTERNAL_ERROR_PREFIX = "Internal bridge state mismatch:";

export interface BridgeAuditSnapshot {
  windowDays: number;
  sessionFilesScanned: number;
  providerSessions: number;
  projectCounts: Array<{ cwd: string; sessions: number }>;
  stopReasons: Record<string, number>;
  topErrors: Array<{ error: string; count: number }>;
  totalUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    totalCost: number;
  };
  upstream5xxErrors: number;
  internalBridgeErrors: number;
  legacyInternalBridgeErrors: number;
  supersededToolWaits: number;
}

function cutoffMs(windowDays: number) {
  return Date.now() - windowDays * 24 * 60 * 60 * 1000;
}

function listJsonlFiles(dir: string, newerThanMs: number, files: string[] = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      listJsonlFiles(path, newerThanMs, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const stat = statSync(path);
      if (stat.mtimeMs >= newerThanMs) files.push(path);
    } catch {
      // ignore unreadable files
    }
  }
  return files;
}

function safeParse(line: string) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function summarizeAuditError(text: string) {
  const trimmed = text.trim();
  const apiMatch = trimmed.match(/API Error:\s*(\d{3})\b/i);
  if (apiMatch) {
    const code = apiMatch[1];
    return ["500", "502", "503", "504"].includes(code)
      ? `API Error: ${code} · check status.claude.com`
      : `API Error: ${code}`;
  }
  if (/OAuth authentication is currently not allowed for this organization/i.test(trimmed)) {
    return "Claude Code auth failed: OAuth isn't allowed for this organization.";
  }
  if (trimmed.includes(CURRENT_INTERNAL_ERROR_PREFIX)) {
    return trimmed.split("\n")[0];
  }
  for (const legacy of LEGACY_INTERNAL_ERROR_TEXTS) {
    if (trimmed.includes(legacy)) return legacy;
  }
  return trimmed.split("\n")[0].slice(0, 220);
}

function isInternalBridgeError(text: string) {
  return text.includes(CURRENT_INTERNAL_ERROR_PREFIX)
    || LEGACY_INTERNAL_ERROR_TEXTS.some((legacy) => text.includes(legacy));
}

function isLegacyInternalBridgeError(text: string) {
  return LEGACY_INTERNAL_ERROR_TEXTS.some((legacy) => text.includes(legacy));
}

function parseRecentDiag(windowDays: number) {
  if (!existsSync(DIAG_PATH)) return { supersededToolWaits: 0 };
  const cutoffIso = new Date(cutoffMs(windowDays)).toISOString();
  let supersededToolWaits = 0;
  for (const line of readFileSync(DIAG_PATH, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const obj = safeParse(line);
    if (!obj || typeof obj.ts !== "string" || obj.ts < cutoffIso) continue;
    if (obj.label === "superseded_waiting_tool_results") supersededToolWaits += 1;
    if (obj.label === "abort_active_run" && obj.reason === "Superseded by new user message") supersededToolWaits += 1;
  }
  return { supersededToolWaits };
}

export async function collectBridgeAudit(windowDays = 7): Promise<BridgeAuditSnapshot> {
  const files = listJsonlFiles(SESSION_ROOT, cutoffMs(windowDays));
  const projectCounts = new Map<string, number>();
  const stopReasons = new Map<string, number>();
  const errorCounts = new Map<string, number>();
  const totalUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
  };

  let providerSessions = 0;
  let upstream5xxErrors = 0;
  let internalBridgeErrors = 0;
  let legacyInternalBridgeErrors = 0;

  for (const path of files) {
    const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) continue;

    let cwd = "(unknown)";
    const header = safeParse(lines[0]);
    if (header?.type === "session" && typeof header.cwd === "string") cwd = header.cwd;

    let sessionHasBridge = false;

    for (const line of lines.slice(1)) {
      const obj = safeParse(line);
      if (!obj) continue;

      if (obj.type === "model_change" && obj.provider === PROVIDER_ID) {
        sessionHasBridge = true;
        continue;
      }

      if (obj.type !== "message" || !obj.message) continue;
      const msg = obj.message;
      const provider = msg.provider;
      if (provider === PROVIDER_ID) sessionHasBridge = true;
      if (msg.role !== "assistant" || provider !== PROVIDER_ID) continue;

      if (typeof msg.stopReason === "string") {
        stopReasons.set(msg.stopReason, (stopReasons.get(msg.stopReason) ?? 0) + 1);
      }

      const usage = msg.usage;
      if (usage) {
        totalUsage.input += Number(usage.input ?? 0);
        totalUsage.output += Number(usage.output ?? 0);
        totalUsage.cacheRead += Number(usage.cacheRead ?? 0);
        totalUsage.cacheWrite += Number(usage.cacheWrite ?? 0);
        totalUsage.totalTokens += Number(usage.totalTokens ?? 0);
        totalUsage.totalCost += Number(usage.cost?.total ?? 0);
      }

      if (typeof msg.errorMessage === "string" && msg.errorMessage.trim()) {
        const summarized = summarizeAuditError(msg.errorMessage);
        errorCounts.set(summarized, (errorCounts.get(summarized) ?? 0) + 1);
        if (/API Error:\s*(500|502|503|504)\b/i.test(msg.errorMessage)) upstream5xxErrors += 1;
        if (isInternalBridgeError(msg.errorMessage)) internalBridgeErrors += 1;
        if (isLegacyInternalBridgeError(msg.errorMessage)) legacyInternalBridgeErrors += 1;
      }
    }

    if (sessionHasBridge) {
      providerSessions += 1;
      projectCounts.set(cwd, (projectCounts.get(cwd) ?? 0) + 1);
    }
  }

  const diag = parseRecentDiag(windowDays);

  return {
    windowDays,
    sessionFilesScanned: files.length,
    providerSessions,
    projectCounts: [...projectCounts.entries()]
      .map(([cwd, sessions]) => ({ cwd, sessions }))
      .sort((a, b) => b.sessions - a.sessions || a.cwd.localeCompare(b.cwd))
      .slice(0, 8),
    stopReasons: Object.fromEntries([...stopReasons.entries()].sort((a, b) => b[1] - a[1])),
    topErrors: [...errorCounts.entries()]
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count || a.error.localeCompare(b.error))
      .slice(0, 8),
    totalUsage,
    upstream5xxErrors,
    internalBridgeErrors,
    legacyInternalBridgeErrors,
    supersededToolWaits: diag.supersededToolWaits,
  };
}

export async function buildBridgeReport(windowDays = 7) {
  const audit = await collectBridgeAudit(windowDays);
  const lines = [
    `reportWindowDays: ${audit.windowDays}`,
    `sessionFilesScanned: ${audit.sessionFilesScanned}`,
    `providerSessions: ${audit.providerSessions}`,
    `totalTokens: ${audit.totalUsage.totalTokens}`,
    `totalCost: ${audit.totalUsage.totalCost.toFixed(6)}`,
    `upstream5xxErrors: ${audit.upstream5xxErrors}`,
    `internalBridgeErrorsRecent: ${audit.internalBridgeErrors}`,
    `legacyInternalBridgeErrorsRecent: ${audit.legacyInternalBridgeErrors}`,
    `supersededToolWaitsRecent: ${audit.supersededToolWaits}`,
    "stopReasons:",
  ];

  for (const [stopReason, count] of Object.entries(audit.stopReasons)) {
    lines.push(`  - ${stopReason}: ${count}`);
  }

  lines.push("topProjects:");
  for (const project of audit.projectCounts) {
    lines.push(`  - ${project.cwd}: ${project.sessions}`);
  }

  lines.push("topErrors:");
  for (const error of audit.topErrors) {
    lines.push(`  - ${error.count} × ${error.error}`);
  }

  return lines;
}
