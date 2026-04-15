import { getModels } from "@mariozechner/pi-ai";

export const PROVIDER_ID = "pi-cc-bridge";

const LATEST_MODEL_IDS = new Set([
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);

export const MODELS = getModels("anthropic")
  .filter((model) => LATEST_MODEL_IDS.has(model.id))
  .map((model) => ({
    id: model.id,
    name: `${model.name} (Pi CC bridge)`,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
