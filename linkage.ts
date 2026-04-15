import { createClient, type Client } from "@libsql/client/node";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { debug } from "./logging";

const DB_PATH = join(homedir(), ".pi", "agent", "pi-cc-bridge.db");

export interface PersistedBridgeSession {
  piSessionId: string;
  cwd: string;
  provider: string;
  model: string | null;
  liveClaudeSessionId: string | null;
  liveCursor: number;
  state: string;
  updatedAt: string;
}

let clientPromise: Promise<Client | null> | null = null;

function isBusyError(error: unknown) {
  return /SQLITE_BUSY|database is locked/i.test(error instanceof Error ? error.message : String(error));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeWithRetry(client: Client, stmt: any, attempts = 6) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.execute(stmt as any);
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || i === attempts - 1) throw error;
      await sleep(25 * (i + 1));
    }
  }
  throw lastError;
}

async function getClient(): Promise<Client | null> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    try {
      mkdirSync(dirname(DB_PATH), { recursive: true });
      const client = createClient({ url: pathToFileURL(DB_PATH).toString() });
      await executeWithRetry(client, `PRAGMA busy_timeout = 5000`);
      await executeWithRetry(client, `
        CREATE TABLE IF NOT EXISTS bridge_sessions (
          pi_session_id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT,
          live_claude_session_id TEXT,
          live_cursor INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'idle',
          updated_at TEXT NOT NULL
        )
      `);
      await executeWithRetry(client, `CREATE INDEX IF NOT EXISTS idx_bridge_sessions_cwd ON bridge_sessions(cwd)`);
      await executeWithRetry(client, `CREATE INDEX IF NOT EXISTS idx_bridge_sessions_updated_at ON bridge_sessions(updated_at)`);
      return client;
    } catch (error) {
      debug("sqlite linkage unavailable", error);
      return null;
    }
  })();
  return clientPromise;
}

function now() {
  return new Date().toISOString();
}

export async function touchBridgeSession(piSessionId: string | undefined, cwd: string, provider: string, model: string) {
  if (!piSessionId) return;
  const client = await getClient();
  if (!client) return;
  await executeWithRetry(client, {
    sql: `
      INSERT INTO bridge_sessions (
        pi_session_id, cwd, provider, model, state, updated_at
      ) VALUES (?, ?, ?, ?, 'idle', ?)
      ON CONFLICT(pi_session_id) DO UPDATE SET
        cwd = excluded.cwd,
        provider = excluded.provider,
        model = excluded.model,
        updated_at = excluded.updated_at
    `,
    args: [piSessionId, cwd, provider, model, now()],
  });
}

export async function loadBridgeSession(piSessionId: string | undefined): Promise<PersistedBridgeSession | null> {
  if (!piSessionId) return null;
  const client = await getClient();
  if (!client) return null;
  const result = await executeWithRetry(client, {
    sql: `
      SELECT
        pi_session_id AS piSessionId,
        cwd,
        provider,
        model,
        live_claude_session_id AS liveClaudeSessionId,
        live_cursor AS liveCursor,
        state,
        updated_at AS updatedAt
      FROM bridge_sessions
      WHERE pi_session_id = ?
    `,
    args: [piSessionId],
  });
  return (result.rows[0] as unknown as PersistedBridgeSession | undefined) ?? null;
}

export async function findLatestBridgeSessionByCwd(cwd: string, excludePiSessionId?: string): Promise<PersistedBridgeSession | null> {
  const client = await getClient();
  if (!client) return null;
  const result = await executeWithRetry(client, {
    sql: `
      SELECT
        pi_session_id AS piSessionId,
        cwd,
        provider,
        model,
        live_claude_session_id AS liveClaudeSessionId,
        live_cursor AS liveCursor,
        state,
        updated_at AS updatedAt
      FROM bridge_sessions
      WHERE cwd = ?
        AND live_claude_session_id IS NOT NULL
        AND (? IS NULL OR pi_session_id != ?)
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    args: [cwd, excludePiSessionId ?? null, excludePiSessionId ?? null],
  });
  return (result.rows[0] as unknown as PersistedBridgeSession | undefined) ?? null;
}

export async function persistBridgeSessionLink(args: {
  piSessionId?: string;
  cwd: string;
  provider: string;
  model: string;
  liveClaudeSessionId: string;
  liveCursor: number;
  state?: string;
}) {
  if (!args.piSessionId) return;
  const client = await getClient();
  if (!client) return;
  await executeWithRetry(client, {
    sql: `
      INSERT INTO bridge_sessions (
        pi_session_id, cwd, provider, model, live_claude_session_id, live_cursor, state, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pi_session_id) DO UPDATE SET
        cwd = excluded.cwd,
        provider = excluded.provider,
        model = excluded.model,
        live_claude_session_id = excluded.live_claude_session_id,
        live_cursor = excluded.live_cursor,
        state = excluded.state,
        updated_at = excluded.updated_at
    `,
    args: [
      args.piSessionId,
      args.cwd,
      args.provider,
      args.model,
      args.liveClaudeSessionId,
      args.liveCursor,
      args.state ?? "idle",
      now(),
    ],
  });
}

export async function setBridgeSessionState(piSessionId: string | undefined, state: string) {
  if (!piSessionId) return;
  const client = await getClient();
  if (!client) return;
  await executeWithRetry(client, {
    sql: `
      UPDATE bridge_sessions
      SET state = ?, updated_at = ?
      WHERE pi_session_id = ?
    `,
    args: [state, now(), piSessionId],
  });
}

export async function clearBridgeSessionLink(piSessionId: string | undefined) {
  if (!piSessionId) return;
  const client = await getClient();
  if (!client) return;
  await executeWithRetry(client, {
    sql: `
      UPDATE bridge_sessions
      SET live_claude_session_id = NULL,
          live_cursor = 0,
          state = 'idle',
          updated_at = ?
      WHERE pi_session_id = ?
    `,
    args: [now(), piSessionId],
  });
}
