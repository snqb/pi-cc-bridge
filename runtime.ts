import type { AssistantMessage, AssistantMessageEventStream, Model } from "@mariozechner/pi-ai";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { calculateCost } from "@mariozechner/pi-ai";
import type { McpResult, PendingToolCall } from "./tools";
import { debug, diag } from "./logging";

export type RunState =
  | "streaming"
  | "waiting_tool_results"
  | "continuing"
  | "done"
  | "aborted"
  | "error";

let nextRunId = 1;

export class Run {
  readonly id = `run-${nextRunId++}`;
  state: RunState = "streaming";
  sdkQuery: ReturnType<typeof query> | null = null;
  stream: AssistantMessageEventStream | null;
  pendingToolCalls = new Map<string, PendingToolCall>();
  pendingResults = new Map<string, McpResult>();
  turnToolCallIds: string[] = [];
  nextHandlerIdx = 0;
  turnOutput: AssistantMessage | null = null;
  turnBlocks: Array<any> = [];
  turnStarted = false;
  turnSawStreamEvent = false;
  turnSawToolCall = false;
  finalized = false;
  closing = false;
  abortSignal: AbortSignal | null = null;
  abortHandler: (() => void) | null = null;

  constructor(stream: AssistantMessageEventStream, model: Model<any>) {
    this.stream = stream;
    this.resetTurn(model);
  }

  resetTurn(model: Model<any>) {
    this.turnOutput = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    this.turnBlocks = this.turnOutput.content as Array<any>;
    this.turnStarted = false;
    this.turnSawStreamEvent = false;
    this.turnSawToolCall = false;
  }

  ensureStarted() {
    if (this.turnStarted || !this.stream || !this.turnOutput || this.finalized || this.closing) return;
    this.stream.push({ type: "start", partial: this.turnOutput });
    this.turnStarted = true;
  }

  push(event: any, options?: { force?: boolean }) {
    if (!this.stream || this.finalized || (this.closing && !options?.force)) {
      diag("post_close_stream_push", { runId: this.id, state: this.state, eventType: event?.type });
      return;
    }
    this.stream.push(event);
  }

  endStream() {
    if (!this.stream) return;
    try {
      this.stream.end();
    } catch (error) {
      debug("endStream failed", this.id, error);
    }
    this.stream = null;
  }

  rebindAbort(signal: AbortSignal | undefined, onAbort: () => void) {
    if (this.abortSignal && this.abortHandler) {
      try { this.abortSignal.removeEventListener("abort", this.abortHandler); } catch {}
    }
    this.abortSignal = null;
    this.abortHandler = null;
    if (!signal) return;
    if (signal.aborted) {
      onAbort();
      return;
    }
    this.abortSignal = signal;
    this.abortHandler = onAbort;
    signal.addEventListener("abort", onAbort, { once: true });
  }

  clearAbortBinding() {
    if (this.abortSignal && this.abortHandler) {
      try { this.abortSignal.removeEventListener("abort", this.abortHandler); } catch {}
    }
    this.abortSignal = null;
    this.abortHandler = null;
  }

  finalize(reason: "stop" | "length" | "error" | "aborted", errorMessage?: string) {
     if (this.finalized || this.closing) return;
+    this.clearAbortBinding();
     if (!this.turnStarted) this.ensureStarted();
     if (this.turnOutput) {
       this.turnOutput.stopReason = reason === "length" ? "length" : reason === "stop" ? (this.turnOutput.stopReason ?? "stop") : reason;
       if (errorMessage) this.turnOutput.errorMessage = errorMessage;
     }
    if (this.finalized || this.closing) return;
    if (!this.turnStarted) this.ensureStarted();
    if (this.turnOutput) {
      this.turnOutput.stopReason = reason === "length" ? "length" : reason === "stop" ? (this.turnOutput.stopReason ?? "stop") : reason;
      if (errorMessage) this.turnOutput.errorMessage = errorMessage;
    }
    this.closing = true;
    if (this.stream && this.turnOutput) {
      if (reason === "error" || reason === "aborted") {
        this.push({ type: "error", reason, error: this.turnOutput }, { force: true });
      } else {
        this.push({ type: "done", reason: reason === "length" ? "length" : "stop", message: this.turnOutput }, { force: true });
      }
    }
    this.endStream();
    this.finalized = true;
    this.closing = false;
  }
}

export class BridgeRuntime {
  activeRun: Run | null = null;
  sharedSession: { sessionId: string; cursor: number; cwd: string } | null = null;

  startRun(stream: AssistantMessageEventStream, model: Model<any>) {
    const run = new Run(stream, model);
    this.activeRun = run;
    return run;
  }

  clearRun(run: Run) {
    run.clearAbortBinding();
    if (this.activeRun?.id === run.id) this.activeRun = null;
  }

  clearSharedSession() {
    this.sharedSession = null;
  }

  abortActiveRun(reason = "Operation aborted") {
    const run = this.activeRun;
    if (!run) return;
    diag("abort_active_run", { runId: run.id, state: run.state, reason });
    run.state = "aborted";
    this.clearSharedSession();
    // close() is the SDK's forceful abort primitive. Calling interrupt()
    // immediately before close() races a control write against a closing stdin
    // pipe and can surface as EPIPE on cancellation/reload.
    try { run.sdkQuery?.close(); } catch {}
    run.sdkQuery = null;
    for (const pending of run.pendingToolCalls.values()) {
      pending.resolve({ content: [{ type: "text", text: reason }] });
    }
    run.pendingToolCalls.clear();
    run.pendingResults.clear();
    run.finalize("aborted", reason);
    this.clearRun(run);
  }
}

export function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>) {
  if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
  if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
  if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
  output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  calculateCost(model, output.usage);
}
