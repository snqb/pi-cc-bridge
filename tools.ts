import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Context, Tool } from "@mariozechner/pi-ai";
import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { pascalCase } from "change-case";
import type { Run } from "./runtime";

export type McpContent = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
export interface McpResult { content: McpContent; isError?: boolean; toolCallId?: string; }
export interface PendingToolCall { toolName: string; resolve: (result: McpResult) => void; }

const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
  read: "read", write: "write", edit: "edit", bash: "bash", grep: "grep", glob: "find",
};
const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
  read: "Read", write: "Write", edit: "Edit", bash: "Bash", grep: "Grep", find: "Glob", glob: "Glob",
};

const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
  read: { file_path: "path" },
  write: { file_path: "path" },
  edit: { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
  grep: { head_limit: "limit" },
};

export const DISALLOWED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
  "NotebookEdit", "EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "CronList",
  "TeamCreate", "TeamDelete", "WebFetch", "WebSearch", "TodoRead", "TodoWrite",
  "EnterPlanMode", "ExitPlanMode", "RemoteTrigger", "SendMessage", "Skill", "TaskOutput",
  "TaskStop", "ToolSearch", "AskUserQuestion", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
];

export function messageContentToText(content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("\n");
}

function toolResultToMcpContent(content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>): McpContent {
  if (typeof content === "string") return [{ type: "text", text: content || "" }];
  if (!Array.isArray(content)) return [{ type: "text", text: "" }];
  const blocks: McpContent = [];
  for (const block of content) {
    if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
    else if (block.type === "image" && block.data && block.mimeType) blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

export function extractAllToolResults(context: Context): McpResult[] {
  const results: McpResult[] = [];
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role === "toolResult") {
      results.unshift({ content: toolResultToMcpContent(msg.content), isError: msg.isError, toolCallId: msg.toolCallId });
    } else if (msg.role === "assistant") {
      break;
    }
  }
  return results;
}

export function extractUserPrompt(messages: Context["messages"]): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return null;
  if (typeof last.content === "string") return last.content;
  return messageContentToText(last.content) || "";
}

export function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content === "string" || !Array.isArray(last.content)) return null;
  let hasImage = false;
  const blocks: ContentBlockParam[] = [];
  for (const block of last.content) {
    if (block.type === "text" && block.text) {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image" && (block as any).data && (block as any).mimeType) {
      hasImage = true;
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: block.mimeType as Base64ImageSource["media_type"], data: block.data },
      });
    }
  }
  return hasImage ? blocks : null;
}

export async function* wrapPromptStream(blocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content: blocks } as MessageParam,
    parent_tool_use_id: null,
  };
}

export function renderReplayTranscript(messages: Context["messages"]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : messageContentToText(msg.content);
      if (text) lines.push(`User: ${text}`);
    } else if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const textParts: string[] = [];
      const toolParts: string[] = [];
      for (const block of content) {
        if (block.type === "text" && block.text) textParts.push(block.text);
        else if (block.type === "toolCall") toolParts.push(`${block.name}(${JSON.stringify(block.arguments ?? {})})`);
      }
      if (textParts.length) lines.push(`Assistant: ${textParts.join("\n")}`);
      if (toolParts.length) lines.push(`Assistant tools: ${toolParts.join(", ")}`);
    } else if (msg.role === "toolResult") {
      const text = messageContentToText(msg.content);
      const prefix = msg.isError ? "Tool error" : "Tool result";
      if (text) lines.push(`${prefix} [${msg.toolName}]: ${text}`);
    }
  }
  return lines.join("\n\n");
}

export async function* wrapReplayPromptStream(history: string, current: string | ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "text",
        text: `Previous conversation transcript for context only. Do not answer this directly; use it to continue naturally.\n\n${history}`,
      }],
    } as MessageParam,
    parent_tool_use_id: null,
    isSynthetic: true,
  };

  yield {
    type: "user",
    message: {
      role: "user",
      content: typeof current === "string" ? current : current,
    } as MessageParam,
    parent_tool_use_id: null,
  };
}

export function mapPiToolNameToSdk(name?: string, customToolNameToSdk?: Map<string, string>): string {
  if (!name) return "";
  const normalized = name.toLowerCase();
  const mapped = customToolNameToSdk?.get(name) ?? customToolNameToSdk?.get(normalized);
  if (mapped) return mapped;
  return PI_TO_SDK_TOOL_NAME[normalized] ?? pascalCase(name);
}

export function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
  const normalized = name.toLowerCase();
  if (SDK_TO_PI_TOOL_NAME[normalized]) return SDK_TO_PI_TOOL_NAME[normalized];
  const mapped = customToolNameToPi?.get(name) ?? customToolNameToPi?.get(normalized);
  if (mapped) return mapped;
  if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
  return name;
}

export function mapToolArgs(toolName: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const input = args ?? {};
  const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const piKey = renames?.[key] ?? key;
    if (!(piKey in result)) result[piKey] = value;
  }
  if (toolName.toLowerCase() === "bash" && result.timeout == null) result.timeout = 120;
  return result;
}

function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  if (Array.isArray(prop.enum)) return z.enum(prop.enum as [string, ...string[]]);
  if (prop.const !== undefined) return z.literal(prop.const as string | number | boolean);
  switch (prop.type) {
    case "string": return z.string();
    case "number":
    case "integer": return z.number();
    case "boolean": return z.boolean();
    case "null": return z.null();
    case "array":
      return prop.items ? z.array(jsonSchemaPropertyToZod(prop.items as Record<string, unknown>)) : z.array(z.unknown());
    case "object":
      if (prop.properties) {
        const shape = jsonSchemaToZodShape(prop);
        return Object.keys(shape).length ? z.object(shape) : z.record(z.string(), z.unknown());
      }
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
  const s = schema as Record<string, unknown>;
  if (!s || s.type !== "object" || !s.properties) return {};
  const props = s.properties as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(s.required) ? s.required as string[] : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) {
    const zodProp = jsonSchemaPropertyToZod(prop);
    shape[key] = required.has(key) ? zodProp : zodProp.optional();
  }
  return shape;
}

export function resolveMcpTools(context: Context): {
  mcpTools: Tool[];
  customToolNameToSdk: Map<string, string>;
  customToolNameToPi: Map<string, string>;
} {
  const mcpTools: Tool[] = [];
  const customToolNameToSdk = new Map<string, string>();
  const customToolNameToPi = new Map<string, string>();
  for (const tool of context.tools ?? []) {
    const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
    mcpTools.push(tool);
    customToolNameToSdk.set(tool.name, sdkName);
    customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
    customToolNameToPi.set(sdkName, tool.name);
    customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
  }
  return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

export function buildMcpServers(run: Run, tools: Tool[]) {
  if (!tools.length) return undefined;
  const mcpTools = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: jsonSchemaToZodShape(tool.parameters),
    handler: async () => {
      const toolCallId = run.turnToolCallIds[run.nextHandlerIdx++];
      if (toolCallId && run.pendingResults.has(toolCallId)) {
        const result = run.pendingResults.get(toolCallId)!;
        run.pendingResults.delete(toolCallId);
        return result as any;
      }
      return new Promise<any>((resolve) => {
        run.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
      });
    },
  }));
  return { [MCP_SERVER_NAME]: createSdkMcpServer({ name: MCP_SERVER_NAME, version: "2.0.0", tools: mcpTools as any }) };
}

