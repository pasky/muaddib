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

export interface ProviderOverrideOptions {
  deepseekBaseUrl?: string;
}

export interface NormalizedProviderOverrideOptions {
  deepseekBaseUrl: string;
}

export function normalizeProviderOverrideOptions(
  options: ProviderOverrideOptions = {},
): NormalizedProviderOverrideOptions {
  return {
    deepseekBaseUrl: normalizeDeepSeekBaseUrl(options.deepseekBaseUrl),
  };
}

export function getOverriddenProviders(): string[] {
  return [DEEPSEEK_PROVIDER];
}

export function resolveProviderOverrideModel(
  provider: string,
  modelId: string,
  options: NormalizedProviderOverrideOptions,
): Model<Api> | undefined {
  if (provider === DEEPSEEK_PROVIDER) {
    return resolveDeepSeekModel(modelId, options.deepseekBaseUrl);
  }

  return undefined;
}

function resolveDeepSeekModel(modelId: string, baseUrl: string): Model<Api> {
  const pricing = DEEPSEEK_PRICING_BY_MODEL[modelId] ?? {
    input: 0,
    output: 0,
  };

  return {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    provider: DEEPSEEK_PROVIDER,
    baseUrl,
    reasoning: modelId.includes("reasoner"),
    input: ["text"],
    cost: {
      input: pricing.input,
      output: pricing.output,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 32_000,
  };
}

function normalizeDeepSeekBaseUrl(url: string | undefined): string {
  const raw = (url ?? DEFAULT_DEEPSEEK_BASE_URL).trim();
  if (!raw) {
    return DEFAULT_DEEPSEEK_BASE_URL;
  }

  const withoutTrailingSlash = raw.replace(/\/+$/u, "");

  if (withoutTrailingSlash.endsWith("/v1/messages")) {
    return withoutTrailingSlash.slice(0, -"/v1/messages".length);
  }

  if (withoutTrailingSlash.endsWith("/messages")) {
    return withoutTrailingSlash.slice(0, -"/messages".length);
  }

  return withoutTrailingSlash;
}
