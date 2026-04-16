import type { AssistantMessageEventStream, Context, Model } from "@mariozechner/pi-ai";
import { clearBridgeSessionLink, loadBridgeSession } from "./linkage";
import { debug } from "./logging";
import type { BridgeRuntime } from "./runtime";
import { extractAllToolResults, renderReplayTranscript, type McpResult } from "./tools";

export interface ActiveRunContinuationResult {
  handled: boolean;
  errorText?: string;
}

export interface ContinuationPlan {
  resumeSessionId?: string;
  replayTranscript?: string;
}

export function continueActiveRun(
  runtime: BridgeRuntime,
  context: Context,
  stream: AssistantMessageEventStream,
  model: Model<any>,
): ActiveRunContinuationResult {
  const lastMessage = context.messages[context.messages.length - 1];
  const activeRun = runtime.activeRun;
  if (!activeRun) return { handled: false };

  if (lastMessage?.role === "toolResult") {
    const results = extractAllToolResults(context);
    activeRun.stream = stream;
    activeRun.resetTurn(model);
    activeRun.state = "continuing";
    for (const result of results) {
      const id = result.toolCallId;
      if (!id) continue;
      if (activeRun.pendingToolCalls.has(id)) {
        const pending = activeRun.pendingToolCalls.get(id)!;
        activeRun.pendingToolCalls.delete(id);
        pending.resolve(result as McpResult);
      } else {
        activeRun.pendingResults.set(id, result as McpResult);
      }
    }
    return { handled: true };
  }

  if (lastMessage?.role === "user") {
    debug("abandoning stale active run", { runId: activeRun.id, state: activeRun.state });
    runtime.abortActiveRun("Superseded by new user message", { classification: "superseded" });
    return { handled: false };
  }

  return {
    handled: true,
    errorText: "Internal bridge state mismatch: missing tool results for pending continuation.",
  };
}

export async function resolveContinuationPlan(
  runtime: BridgeRuntime,
  piSessionId: string | undefined,
  cwd: string,
  priorMessages: Context["messages"],
): Promise<ContinuationPlan> {
  let shared = runtime.sharedSession;
  if (!shared) {
    const persisted = await loadBridgeSession(piSessionId);
    if (persisted?.state === "waiting_tool_results") {
      runtime.clearSharedSession();
      await clearBridgeSessionLink(piSessionId);
    } else if (persisted?.liveClaudeSessionId && persisted.cwd === cwd) {
      shared = {
        sessionId: persisted.liveClaudeSessionId,
        cursor: persisted.liveCursor,
        cwd: persisted.cwd,
      };
      runtime.sharedSession = shared;
    }
  }

  let resumeSessionId: string | undefined;
  if (shared && shared.cwd === cwd) {
    const missed = priorMessages.slice(shared.cursor);
    const trailingAssistantOnly = missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
    if (missed.length === 0 || trailingAssistantOnly) {
      resumeSessionId = shared.sessionId;
      if (trailingAssistantOnly) {
        runtime.sharedSession = { ...shared, cursor: priorMessages.length };
      }
    }
  }

  if (resumeSessionId || priorMessages.length === 0) {
    return { resumeSessionId };
  }

  return {
    replayTranscript: renderReplayTranscript(priorMessages),
  };
}
