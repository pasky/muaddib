import { getModel, type Api, type KnownProvider, type Model } from "@mariozechner/pi-ai";

const DEEPSEEK_PROVIDER = "deepseek";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic";

const OPENROUTER_PROVIDER = "openrouter";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

interface OpenRouterModelEntry {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  inputModalities: string[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

// Keyed by model id (e.g. "google/gemini-3.1-pro-preview").
const openRouterModelCache = new Map<string, OpenRouterModelEntry>();
// Fire-and-forget on module load so the cache is warm before requests arrive.
void fetchOpenRouterModels();

async function fetchOpenRouterModels(): Promise<void> {
  try {
    const resp = await fetch(`${OPENROUTER_BASE_URL}/models`);
    if (!resp.ok) {
      console.warn(`OpenRouter model list fetch failed: ${resp.status} ${resp.statusText}`);
      return;
    }
    const json = (await resp.json()) as {
      data: Array<{
        id: string;
        context_length: number;
        top_provider: { max_completion_tokens: number | null };
        architecture: { input_modalities: string[] };
        supported_parameters: string[];
        pricing: {
          prompt: string;
          completion: string;
          input_cache_read?: string;
          input_cache_write?: string;
        };
      }>;
    };
    for (const m of json.data) {
      openRouterModelCache.set(m.id, {
        contextWindow: m.context_length,
        maxTokens: m.top_provider.max_completion_tokens ?? 8_192,
        reasoning: m.supported_parameters.includes("include_reasoning"),
        inputModalities: m.architecture.input_modalities,
        cost: {
          // OR pricing is per-token; convert to per-million for pi-ai convention.
          input: parseFloat(m.pricing.prompt) * 1_000_000,
          output: parseFloat(m.pricing.completion) * 1_000_000,
          cacheRead: parseFloat(m.pricing.input_cache_read ?? "0") * 1_000_000,
          cacheWrite: parseFloat(m.pricing.input_cache_write ?? "0") * 1_000_000,
        },
      });
    }
  } catch (err) {
    console.warn(`OpenRouter model list fetch error: ${err}`);
  }
}

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
  return [DEEPSEEK_PROVIDER, OPENROUTER_PROVIDER];
}

export function resolveProviderOverrideModel(
  provider: string,
  modelId: string,
): Model<Api> | undefined {
  if (provider === DEEPSEEK_PROVIDER) {
    return resolveDeepSeekModel(modelId);
  }

  if (provider === OPENROUTER_PROVIDER) {
    return resolveOpenRouterModel(modelId);
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

function resolveOpenRouterModel(modelId: string): Model<Api> | undefined {
  // Prefer the static registry entry if it exists.
  const known = getModel(OPENROUTER_PROVIDER as KnownProvider, modelId as never) as
    | Model<Api>
    | undefined;
  if (known) {
    return known;
  }

  // Use live OpenRouter model data if the background fetch has landed.
  const cached = openRouterModelCache.get(modelId);
  if (cached) {
    return {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: OPENROUTER_PROVIDER,
      baseUrl: OPENROUTER_BASE_URL,
      reasoning: cached.reasoning,
      input: cached.inputModalities.filter((m): m is "text" | "image" => m === "text" || m === "image"),
      cost: cached.cost,
      contextWindow: cached.contextWindow,
      maxTokens: cached.maxTokens,
    };
  }

  // Cache not yet populated (fetch still in flight on startup) — synthesize a
  // best-effort entry so the call isn't rejected. Cost will be zero.
  console.warn(
    `OpenRouter model '${modelId}' not in static registry or live cache yet; using zero-cost fallback.`,
  );
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: OPENROUTER_PROVIDER,
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: modelId.includes("thinking") || modelId.includes("reasoner"),
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}
