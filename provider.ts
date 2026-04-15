import * as piAi from "@mariozechner/pi-ai";
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { query, type SDKMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { BridgeConfig } from "./config";
import { debug, diag } from "./logging";
import { clearBridgeSessionLink, loadBridgeSession, persistBridgeSessionLink, setBridgeSessionState, touchBridgeSession } from "./linkage";
import { compileSystemPrompt } from "./prompt";
import { BridgeRuntime, updateUsage } from "./runtime";
import {
  DISALLOWED_BUILTIN_TOOLS,
  buildMcpServers,
  extractAllToolResults,
  extractUserPrompt,
  extractUserPromptBlocks,
  mapToolArgs,
  mapToolName,
  renderReplayTranscript,
  resolveMcpTools,
  wrapPromptStream,
  wrapReplayPromptStream,
  type McpResult,
} from "./tools";

const _piAi = piAi as any;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}
const newAssistantMessageEventStream: () => AssistantMessageEventStream =
  typeof _piAi.createAssistantMessageEventStream === "function"
    ? _piAi.createAssistantMessageEventStream
    : () => new _piAi.AssistantMessageEventStream();

const MAX_TRANSIENT_RETRIES = 2;

function bridgeErrorMessage(model: Model<any>, errorText: string) {
  return {
    role: "assistant" as const,
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
    stopReason: "error" as const,
    timestamp: Date.now(),
    errorMessage: errorText,
  };
}

function isRawApiErrorText(text: string): boolean {
  return /^\s*API Error:\s*\d{3}\b/i.test(text.trim());
}

function isTransientClaudeError(text: string): boolean {
  return /API Error:\s*(500|502|503|504)\b/i.test(text)
    || /Internal server error/i.test(text)
    || /overloaded/i.test(text)
    || /ECONNRESET|ETIMEDOUT|socket hang up/i.test(text);
}

function summarizeErrorForUser(text: string): string {
  const trimmed = text.trim();
  const apiMatch = trimmed.match(/API Error:\s*(\d{3})\b[\s\S]*/i);
  if (apiMatch) {
    const code = apiMatch[1];
    if (["500", "502", "503", "504"].includes(code)) return `API Error: ${code} · check status.claude.com`;
    return `API Error: ${code}`;
  }
  if (/OAuth authentication is currently not allowed for this organization/i.test(trimmed)) {
    return "Claude Code auth failed: OAuth isn't allowed for this organization.";
  }
  return trimmed.replace(/^Error:\s*/, "");
}

function setCleanErrorOutput(run: ReturnType<BridgeRuntime["startRun"]>, model: Model<any>, rawErrorText: string) {
  const error = bridgeErrorMessage(model, rawErrorText) as any;
  error.content = [{ type: "text", text: summarizeErrorForUser(rawErrorText) }];
  run.turnOutput = error;
  run.turnBlocks = error.content;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "tool_use": return "toolUse";
    case "max_tokens": return "length";
    default: return "stop";
  }
}

function parsePartialJson(input: string, fallback: Record<string, unknown>) {
  if (!input) return fallback;
  try { return JSON.parse(input); } catch { return fallback; }
}

function processStreamEvent(run: ReturnType<BridgeRuntime["startRun"]>, message: SDKMessage, customToolNameToPi: Map<string, string>, model: Model<any>) {
  if (!run.stream || !run.turnOutput) return;
  run.turnSawStreamEvent = true;
  const event = (message as SDKMessage & { event: any }).event;

  if (event?.type === "message_start") {
    run.turnToolCallIds = [];
    run.nextHandlerIdx = 0;
    if (event.message?.usage) updateUsage(run.turnOutput, event.message.usage, model);
    return;
  }

  if (event?.type === "content_block_start") {
    run.ensureStarted();
    if (event.content_block?.type === "text") {
      run.turnBlocks.push({ type: "text", text: "", index: event.index });
      run.push({ type: "text_start", contentIndex: run.turnBlocks.length - 1, partial: run.turnOutput });
    } else if (event.content_block?.type === "thinking") {
      run.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
      run.push({ type: "thinking_start", contentIndex: run.turnBlocks.length - 1, partial: run.turnOutput });
    } else if (event.content_block?.type === "tool_use") {
      run.turnSawToolCall = true;
      run.turnToolCallIds.push(event.content_block.id);
      run.turnBlocks.push({
        type: "toolCall",
        id: event.content_block.id,
        name: mapToolName(event.content_block.name, customToolNameToPi),
        arguments: (event.content_block.input as Record<string, unknown>) ?? {},
        partialJson: "",
        index: event.index,
      });
      run.push({ type: "toolcall_start", contentIndex: run.turnBlocks.length - 1, partial: run.turnOutput });
    }
    return;
  }

  if (event?.type === "content_block_delta") {
    const index = run.turnBlocks.findIndex((b: any) => b.index === event.index);
    const block = run.turnBlocks[index];
    if (!block) return;
    if (event.delta?.type === "text_delta" && block.type === "text") {
      block.text += event.delta.text;
      run.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: run.turnOutput });
    } else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += event.delta.thinking;
      run.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: run.turnOutput });
    } else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
      block.partialJson += event.delta.partial_json;
    } else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
      block.thinkingSignature += event.delta.signature;
    }
    return;
  }

  if (event?.type === "content_block_stop") {
    const index = run.turnBlocks.findIndex((b: any) => b.index === event.index);
    const block = run.turnBlocks[index];
    if (!block) return;
    delete block.index;
    if (block.type === "text") {
      run.push({ type: "text_end", contentIndex: index, content: block.text, partial: run.turnOutput });
    } else if (block.type === "thinking") {
      run.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: run.turnOutput });
    } else if (block.type === "toolCall") {
      block.arguments = mapToolArgs(block.name, parsePartialJson(block.partialJson, block.arguments));
      delete block.partialJson;
      run.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: run.turnOutput });
    }
    return;
  }

  if (event?.type === "message_delta") {
    run.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
    if (event.usage) updateUsage(run.turnOutput, event.usage, model);
    return;
  }

  if (event?.type === "message_stop" && run.turnSawToolCall) {
    run.turnOutput.stopReason = "toolUse";
    run.push({ type: "done", reason: "toolUse", message: run.turnOutput });
    run.endStream();
    run.clearAbortBinding();
    run.state = "waiting_tool_results";
  }
}

function processAssistantMessage(run: ReturnType<BridgeRuntime["startRun"]>, message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>) {
  if (run.turnSawStreamEvent) return;
  const assistantMsg = (message as any).message;
  if (!assistantMsg?.content) return;
  run.turnToolCallIds = [];
  run.nextHandlerIdx = 0;

  for (const block of assistantMsg.content) {
    if (block.type === "text" && block.text) {
      if (isRawApiErrorText(block.text)) continue;
      run.ensureStarted();
      run.turnBlocks.push({ type: "text", text: block.text });
      const idx = run.turnBlocks.length - 1;
      run.push({ type: "text_start", contentIndex: idx, partial: run.turnOutput });
      run.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: run.turnOutput });
      run.push({ type: "text_end", contentIndex: idx, content: block.text, partial: run.turnOutput });
    } else if (block.type === "thinking") {
      run.ensureStarted();
      run.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
      const idx = run.turnBlocks.length - 1;
      run.push({ type: "thinking_start", contentIndex: idx, partial: run.turnOutput });
      if (block.thinking) run.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: run.turnOutput });
      run.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: run.turnOutput });
    } else if (block.type === "tool_use") {
      run.ensureStarted();
      run.turnSawToolCall = true;
      run.turnToolCallIds.push(block.id);
      run.turnBlocks.push({ type: "toolCall", id: block.id, name: mapToolName(block.name, customToolNameToPi), arguments: mapToolArgs(mapToolName(block.name, customToolNameToPi), block.input) });
      const idx = run.turnBlocks.length - 1;
      run.push({ type: "toolcall_start", contentIndex: idx, partial: run.turnOutput });
      run.push({ type: "toolcall_end", contentIndex: idx, toolCall: run.turnBlocks[idx], partial: run.turnOutput });
    }
  }

  if (assistantMsg.usage && run.turnOutput) updateUsage(run.turnOutput, assistantMsg.usage, model);

  if (run.turnSawToolCall && run.stream && run.turnOutput) {
    run.turnOutput.stopReason = "toolUse";
    run.push({ type: "done", reason: "toolUse", message: run.turnOutput });
    run.endStream();
    run.clearAbortBinding();
    run.state = "waiting_tool_results";
  }
}

async function consumeQuery(runtime: BridgeRuntime, run: ReturnType<BridgeRuntime["startRun"]>, makeSdkQuery: () => ReturnType<typeof query>, customToolNameToPi: Map<string, string>, model: Model<any>, contextMessageCount: number, cwd: string) {
  let attempt = 0;

  while (true) {
    let done = false;
    let capturedSessionId: string | undefined;
    const sdkQuery = makeSdkQuery();
    run.sdkQuery = sdkQuery;

    try {
      for await (const message of sdkQuery) {
        if (run.finalized) break;
        switch (message.type) {
          case "stream_event":
            processStreamEvent(run, message, customToolNameToPi, model);
            break;
          case "assistant":
            if ((message as any).session_id) capturedSessionId = (message as any).session_id;
            processAssistantMessage(run, message, model, customToolNameToPi);
            break;
          case "result": {
            if ((message as any).session_id) capturedSessionId = (message as any).session_id;
            if (!run.turnSawStreamEvent && message.subtype === "success" && (message as any).result) {
              run.ensureStarted();
              const text = (message as any).result || "";
              if (!isRawApiErrorText(text)) {
                run.turnBlocks.push({ type: "text", text });
                const idx = run.turnBlocks.length - 1;
                run.push({ type: "text_start", contentIndex: idx, partial: run.turnOutput });
                run.push({ type: "text_delta", contentIndex: idx, delta: text, partial: run.turnOutput });
                run.push({ type: "text_end", contentIndex: idx, content: text, partial: run.turnOutput });
              }
            }
            if (run.turnOutput && (message as any).usage && run.turnOutput.usage.totalTokens === 0) {
              updateUsage(run.turnOutput, (message as any).usage, model);
            }
            break;
          }
          case "system": {
            if ((message as any).subtype === "init" && (message as any).session_id) {
              capturedSessionId = (message as any).session_id;
            }
            break;
          }
        }
      }
      done = true;
    } catch (error) {
      const raw = errorMessage(error);
      debug("consumeQuery error", run.id, raw, { attempt });
      runtime.clearSharedSession();
      const aborted = run.state === "aborted" || run.finalized;
      const canRetry = !aborted && !run.turnStarted && isTransientClaudeError(raw) && attempt < MAX_TRANSIENT_RETRIES;
      if (canRetry) {
        attempt += 1;
        diag("transient_retry", { runId: run.id, attempt, error: summarizeErrorForUser(raw) });
        run.resetTurn(model);
        await sleep(500 * attempt);
        continue;
      }
      run.state = aborted ? "aborted" : "error";
      await clearBridgeSessionLink(run.piSessionId);
      if (!aborted) setCleanErrorOutput(run, model, raw);
      run.finalize(aborted ? "aborted" : "error", raw);
      runtime.clearRun(run);
      return;
    } finally {
      try { sdkQuery.close(); } catch {}
      if (run.sdkQuery === sdkQuery) run.sdkQuery = null;
    }

    if (!done || run.finalized) return;
    if (capturedSessionId) {
      runtime.sharedSession = { sessionId: capturedSessionId, cursor: contextMessageCount, cwd };
      await persistBridgeSessionLink({
        piSessionId: run.piSessionId,
        cwd,
        provider: model.provider,
        model: model.id,
        liveClaudeSessionId: capturedSessionId,
        liveCursor: contextMessageCount,
        state: run.state === "waiting_tool_results" ? "waiting_tool_results" : "idle",
      });
      debug("captured session", { runId: run.id, sessionId: capturedSessionId, cursor: contextMessageCount });
    } else if (run.piSessionId) {
      await setBridgeSessionState(run.piSessionId, run.state === "waiting_tool_results" ? "waiting_tool_results" : "idle");
    }
    if (run.state === "waiting_tool_results") return;
    run.state = "done";
    if (run.piSessionId) await setBridgeSessionState(run.piSessionId, "idle");
    run.finalize(run.turnOutput?.stopReason === "length" ? "length" : "stop");
    runtime.clearRun(run);
    return;
  }
}

export function createProvider(runtime: BridgeRuntime, config: BridgeConfig) {
  return function streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
    const stream = newAssistantMessageEventStream();
    const lastMessage = context.messages[context.messages.length - 1];

    const activeRun = runtime.activeRun;
    if (activeRun) {
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
        return stream;
      }

      if (lastMessage?.role === "user") {
        debug("abandoning stale active run", { runId: activeRun.id, state: activeRun.state });
        runtime.abortActiveRun("Superseded by new user message");
      } else {
        queueMicrotask(() => {
          stream.push({ type: "error", reason: "error", error: bridgeErrorMessage(model, "Bridge was waiting for tool results but none were provided.") as any });
          stream.end();
        });
        return stream;
      }
    }

    if (!lastMessage || lastMessage.role !== "user") {
      queueMicrotask(() => {
        stream.push({ type: "error", reason: "error", error: bridgeErrorMessage(model, "Bridge expected a user message to start a query.") as any });
        stream.end();
      });
      return stream;
    }

    const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);
    const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    const piSessionId = options?.sessionId ?? runtime.currentPiSessionId ?? undefined;
    const priorMessages = context.messages.slice(0, -1);
    const promptBlocks = extractUserPromptBlocks(context.messages);
    const promptText = extractUserPrompt(context.messages) ?? "[continue]";

    void (async () => {
      await touchBridgeSession(piSessionId, cwd, model.provider, model.id);

      let shared = runtime.sharedSession;
      if (!shared) {
        const persisted = await loadBridgeSession(piSessionId);
        if (persisted?.state === "waiting_tool_results") {
          await clearBridgeSessionLink(piSessionId);
        } else if (persisted?.liveClaudeSessionId && persisted.cwd === cwd) {
          shared = { sessionId: persisted.liveClaudeSessionId, cursor: persisted.liveCursor, cwd: persisted.cwd };
          runtime.sharedSession = shared;
        }
      }

      const run = runtime.startRun(stream, model);
      run.piSessionId = piSessionId;
      run.cwd = cwd;
      const mcpServers = buildMcpServers(run, mcpTools);
      let resumeSessionId: string | undefined;
      let replayTranscript: string | undefined;

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

      if (!resumeSessionId && priorMessages.length > 0) {
        replayTranscript = renderReplayTranscript(priorMessages);
      }

      const prompt = replayTranscript
        ? wrapReplayPromptStream(replayTranscript, promptBlocks ?? promptText)
        : promptBlocks
          ? wrapPromptStream(promptBlocks)
          : promptText;
      const systemPrompt = compileSystemPrompt(config.behaviorProfile ?? "vanilla", context.systemPrompt);
      debug("fresh query", {
        runId: run.id,
        profile: config.behaviorProfile ?? "vanilla",
        promptLength: promptText.length,
        systemPromptLength: systemPrompt.length,
        tools: mcpTools.length,
        resume: Boolean(resumeSessionId),
        priorMessages: priorMessages.length,
        replayTranscriptLength: replayTranscript?.length ?? 0,
      });

      const makeSdkQuery = () => query({
        prompt,
        options: {
          cwd,
          permissionMode: "bypassPermissions",
          includePartialMessages: true,
          disallowedTools: DISALLOWED_BUILTIN_TOOLS,
          allowedTools: [`${mcpServers ? "mcp__custom-tools__*" : ""}`].filter(Boolean),
          systemPrompt,
          settingSources: ["user", "project"] as SettingSource[],
          extraArgs: { model: model.id, "strict-mcp-config": null },
          ...(mcpServers ? { mcpServers } : {}),
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        },
      });

      await consumeQuery(runtime, run, makeSdkQuery, customToolNameToPi, model, context.messages.length, cwd);
      run.clearAbortBinding();
    })().catch((error) => {
      queueMicrotask(() => {
        stream.push({ type: "error", reason: "error", error: bridgeErrorMessage(model, errorMessage(error)) as any });
        stream.end();
      });
    });

    return stream;
  };
}
