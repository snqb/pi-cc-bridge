import type { BehaviorProfile } from "./config";

const VANILLA_PREAMBLE = `You are running inside Pi.

Behave like Pi, not Claude Code.

Rules:
- Be concise, direct, and low-noise.
- Pi tools are the primary interface.
- Memory tools, browser workflows, subagents, and custom Pi tools are first-class.
- If a file path is known, read it directly.
- Prefer focused inspection over broad search.
- Do not use repo-wide grep/glob as a reflex.
- Keep the workflow lean.`;

const HYBRID_PREAMBLE = `You are running inside Pi.

Prefer Pi's style and tool usage, but you may explore a bit more when genuinely needed. Stay concise and avoid unnecessary broad searches.`;

const CLAUDE_PREAMBLE = `You are running inside Pi, but the user explicitly wants a more Claude Code-like workflow. Pi tools still execute on the Pi side.`;

const TOOL_MAPPING = `Tool naming note:
- Pi instructions may refer to read, write, edit, bash, grep, find, browser, memory_search, mem_save, subagent, and interactive_shell.
- Call the corresponding available MCP tools even if transport names are prefixed.`;

const BROWSER_RULES = `Browser automation note:
- If using ~/.pi/agent/skills/browser-testing/browser.js (ABP CLI), do NOT use Playwright-style selectors with click/hover/drag helpers.
- browser.js click/hover/drag expect coordinates, not selector strings like text=... or css selectors.
- First inspect with observe, screenshot --markup clickable,typeable,grid, text, eval, or pick; then click using coordinates.
- If a browser.js command prints usage/help instead of action output, treat that as a failed command, explain briefly, and recover with the correct ABP workflow.`;

function extractSkillsCatalog(baseSystemPrompt?: string): string {
  if (!baseSystemPrompt) return "";
  const start = baseSystemPrompt.indexOf("<available_skills>");
  const end = baseSystemPrompt.indexOf("</available_skills>", start);
  if (start === -1 || end === -1) return "";
  const block = baseSystemPrompt.slice(start, end + "</available_skills>".length);
  const entries = [...block.matchAll(/<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g)];
  if (!entries.length) return "";
  const lines = [
    "Available on-demand Pi skills:",
    "- If a skill name/description matches the user's request, read its SKILL.md file directly.",
  ];
  for (const [, name, description, location] of entries) {
    lines.push(`- ${name.trim()} — ${description.trim()} (location: ${location.trim()})`);
  }
  return lines.join("\n");
}

export function compileSystemPrompt(profile: BehaviorProfile, baseSystemPrompt?: string): string {
  const preamble = profile === "claude"
    ? CLAUDE_PREAMBLE
    : profile === "hybrid"
      ? HYBRID_PREAMBLE
      : VANILLA_PREAMBLE;

  const skillsCatalog = extractSkillsCatalog(baseSystemPrompt);
  return [preamble.trim(), TOOL_MAPPING.trim(), BROWSER_RULES.trim(), skillsCatalog.trim()].filter(Boolean).join("\n\n");
}
