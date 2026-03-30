import { getModel, type Api, type KnownProvider, type Model, type OpenAICompletionsCompat } from "@mariozechner/pi-ai";

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
  providerRouting?: string[],
): Model<Api> | undefined {
  if (provider === DEEPSEEK_PROVIDER) {
    return resolveDeepSeekModel(modelId);
  }

  if (provider === OPENROUTER_PROVIDER) {
    return resolveOpenRouterModel(modelId, providerRouting);
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

/**
 * Normalize a model ID for OpenRouter lookup.
 *
 * Anthropic uses hyphens in version numbers (e.g. `claude-opus-4-6`),
 * while OpenRouter uses dots (e.g. `anthropic/claude-opus-4.6`).
 * This converts digit-hyphen-digit sequences to digit-dot-digit.
 */
function normalizeOpenRouterModelId(modelId: string): string {
  return modelId.replace(/(\d)-(\d)/g, "$1.$2");
}

function resolveOpenRouterModel(modelId: string, providerRouting?: string[]): Model<Api> | undefined {
  const compat: OpenAICompletionsCompat | undefined = providerRouting?.length
    ? { openRouterRouting: { only: providerRouting } }
    : undefined;

  // Try exact match first, then normalized version (e.g. hyphens → dots in versions).
  const normalized = normalizeOpenRouterModelId(modelId);
  const candidates = normalized !== modelId ? [modelId, normalized] : [modelId];

  for (const candidate of candidates) {
    // Prefer the static registry entry if it exists.
    const known = getModel(OPENROUTER_PROVIDER as KnownProvider, candidate as never) as
      | Model<Api>
      | undefined;
    if (known) {
      return compat ? { ...known, compat } : known;
    }

    // Use live OpenRouter model data if the background fetch has landed.
    const cached = openRouterModelCache.get(candidate);
    if (cached) {
      return {
        id: candidate,
        name: candidate,
        api: "openai-completions",
        provider: OPENROUTER_PROVIDER,
        baseUrl: OPENROUTER_BASE_URL,
        reasoning: cached.reasoning,
        input: cached.inputModalities.filter((m): m is "text" | "image" => m === "text" || m === "image"),
        cost: cached.cost,
        contextWindow: cached.contextWindow,
        maxTokens: cached.maxTokens,
        compat,
      };
    }
  }

  // Cache not yet populated (fetch still in flight on startup) — synthesize a
  // best-effort entry so the call isn't rejected. Cost will be zero.
  // Use the normalized ID so OpenRouter receives the correct model name.
  const fallbackId = normalized !== modelId ? normalized : modelId;
  console.warn(
    `OpenRouter model '${modelId}' not in static registry or live cache yet; using zero-cost fallback (id=${fallbackId}).`,
  );
  return {
    id: fallbackId,
    name: fallbackId,
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
    compat,
  };
}
