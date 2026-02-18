import { type Api, type Model } from "@mariozechner/pi-ai";

const DEEPSEEK_PROVIDER = "deepseek";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic";

// Pricing in USD per 1M tokens (prompt/output). Matches Python pricing tables.
const DEEPSEEK_PRICING_BY_MODEL: Record<string, { input: number; output: number }> = {
  "deepseek-chat": {
    input: 0.14,
    output: 0.28,
  },
  "deepseek-reasoner": {
    input: 0.55,
    output: 2.19,
  },
};

export function getOverriddenProviders(): string[] {
  return [DEEPSEEK_PROVIDER];
}

export function resolveProviderOverrideModel(
  provider: string,
  modelId: string,
): Model<Api> | undefined {
  if (provider === DEEPSEEK_PROVIDER) {
    return resolveDeepSeekModel(modelId);
  }

  return undefined;
}

function resolveDeepSeekModel(modelId: string): Model<Api> {
  const pricing = DEEPSEEK_PRICING_BY_MODEL[modelId];
  if (!pricing) {
    const known = Object.keys(DEEPSEEK_PRICING_BY_MODEL).join(", ");
    console.warn(
      `Unknown DeepSeek model '${modelId}': pricing unavailable (known models: ${known}). Cost tracking will report zero.`,
    );
  }

  const normalizedUrl = DEFAULT_DEEPSEEK_BASE_URL;

  return {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    provider: DEEPSEEK_PROVIDER,
    baseUrl: normalizedUrl,
    reasoning: modelId.includes("reasoner"),
    input: ["text"],
    cost: {
      input: pricing?.input ?? 0,
      output: pricing?.output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 32_000,
  };
}
