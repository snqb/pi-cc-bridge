import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOG_PATH = join(homedir(), ".pi", "agent", "pi-cc-bridge.log");
const DIAG_PATH = join(homedir(), ".pi", "agent", "pi-cc-bridge-diag.log");

let debugEnabled = process.env.PI_CC_BRIDGE_DEBUG === "1";

function ensureDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

export function setDebug(enabled: boolean) {
  debugEnabled = enabled || process.env.PI_CC_BRIDGE_DEBUG === "1";
}

export function debug(...args: unknown[]) {
  if (!debugEnabled) return;
  ensureDir(LOG_PATH);
  const ts = new Date().toISOString();
  const msg = args.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ");
  appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
}

export function diag(label: string, payload: Record<string, unknown>) {
  ensureDir(DIAG_PATH);
  appendFileSync(DIAG_PATH, JSON.stringify({ ts: new Date().toISOString(), label, ...payload }) + "\n");
  debug("DIAG", label, payload);
}
