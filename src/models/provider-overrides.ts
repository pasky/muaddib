import { getModel, type Api, type KnownProvider, type Model, type OpenAICompletionsCompat } from "@mariozechner/pi-ai";

const DEEPSEEK_PROVIDER = "deepseek";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic";

const OPENROUTER_PROVIDER = "openrouter";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

interface OpenRouterEndpoint {
  tag: string;
  provider_name: string;
  context_length: number;
  max_completion_tokens: number | null;
  supported_parameters: string[];
  status: number;
  pricing: {
    prompt: string;
    completion: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

interface OpenRouterEndpointsPayload {
  id: string;
  architecture: { input_modalities: string[] };
  endpoints: OpenRouterEndpoint[];
}

// Keyed by model id (whatever form was actually used against OpenRouter,
// e.g. "moonshotai/kimi-k2.6"). Populated lazily on first lookup miss.
const endpointsCache = new Map<string, OpenRouterEndpointsPayload>();
const endpointsInflight = new Map<string, Promise<OpenRouterEndpointsPayload | undefined>>();

export async function fetchOpenRouterEndpoints(modelId: string): Promise<OpenRouterEndpointsPayload | undefined> {
  const cached = endpointsCache.get(modelId);
  if (cached) return cached;
  const inflight = endpointsInflight.get(modelId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const resp = await fetch(`${OPENROUTER_BASE_URL}/models/${modelId}/endpoints`);
      if (!resp.ok) {
        console.warn(`OpenRouter endpoints fetch for '${modelId}' failed: ${resp.status} ${resp.statusText}`);
        return undefined;
      }
      const json = (await resp.json()) as { data: OpenRouterEndpointsPayload };
      endpointsCache.set(modelId, json.data);
      return json.data;
    } catch (err) {
      console.warn(`OpenRouter endpoints fetch for '${modelId}' error: ${err}`);
      return undefined;
    } finally {
      endpointsInflight.delete(modelId);
    }
  })();
  endpointsInflight.set(modelId, promise);
  return promise;
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

  return {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    provider: DEEPSEEK_PROVIDER,
    baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
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

function pickEndpoint(
  payload: OpenRouterEndpointsPayload,
  providerRouting: string[] | undefined,
): OpenRouterEndpoint | undefined {
  if (providerRouting?.length) {
    const match = payload.endpoints.find((e) => e.tag === providerRouting[0]);
    if (match) return match;
    console.warn(
      `OpenRouter model '${payload.id}' has no endpoint matching provider routing '${providerRouting[0]}' ` +
        `(available: ${payload.endpoints.map((e) => e.tag).join(", ")}); using default endpoint.`,
    );
  }
  return payload.endpoints.find((e) => e.status >= 0) ?? payload.endpoints[0];
}

function buildModelFromEndpoint(
  modelId: string,
  payload: OpenRouterEndpointsPayload,
  endpoint: OpenRouterEndpoint,
  compat: OpenAICompletionsCompat | undefined,
): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: OPENROUTER_PROVIDER,
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: endpoint.supported_parameters.includes("include_reasoning"),
    input: payload.architecture.input_modalities.filter(
      (m): m is "text" | "image" => m === "text" || m === "image",
    ),
    cost: {
      // OR pricing is per-token; convert to per-million for pi-ai convention.
      input: parseFloat(endpoint.pricing.prompt) * 1_000_000,
      output: parseFloat(endpoint.pricing.completion) * 1_000_000,
      cacheRead: parseFloat(endpoint.pricing.input_cache_read ?? "0") * 1_000_000,
      cacheWrite: parseFloat(endpoint.pricing.input_cache_write ?? "0") * 1_000_000,
    },
    contextWindow: endpoint.context_length,
    maxTokens: endpoint.max_completion_tokens ?? 8_192,
    compat,
  };
}

function resolveOpenRouterModel(modelId: string, providerRouting?: string[]): Model<Api> | undefined {
  const compat: OpenAICompletionsCompat | undefined = providerRouting?.length
    ? { openRouterRouting: { only: providerRouting } }
    : undefined;

  // Anthropic-style hyphenated versions (`claude-opus-4-6`) map to dotted form on OpenRouter
  // (`anthropic/claude-opus-4.6`). Try the raw id first, then the normalized form.
  const normalized = normalizeOpenRouterModelId(modelId);
  const candidates = normalized !== modelId ? [modelId, normalized] : [modelId];

  // Endpoint cache is the source of truth for pricing. Use per-endpoint pricing when
  // providerRouting is set so we don't inherit the misleading "min across endpoints"
  // pricing that OpenRouter surfaces on the top-level /models entry.
  for (const candidate of candidates) {
    const cached = endpointsCache.get(candidate);
    if (cached) {
      const endpoint = pickEndpoint(cached, providerRouting);
      if (endpoint) return buildModelFromEndpoint(candidate, cached, endpoint, compat);
    }
  }

  // Kick off a lazy fetch so subsequent calls resolve with real pricing.
  // Prefer the normalized form since that's what OpenRouter serves.
  const fetchId = candidates[candidates.length - 1];
  void fetchOpenRouterEndpoints(fetchId);

  // Cache cold: fall back to pi-ai's static registry entry if available.
  for (const candidate of candidates) {
    const known = getModel(OPENROUTER_PROVIDER as KnownProvider, candidate as never) as
      | Model<Api>
      | undefined;
    if (known) {
      return compat ? { ...known, compat } : known;
    }
  }

  // Nothing known yet — synthesize a zero-cost entry so the call isn't rejected.
  // The next call for this model (after the lazy fetch lands) will use real pricing.
  console.warn(
    `OpenRouter model '${modelId}' endpoints not cached yet and not in static registry; ` +
      `using zero-cost fallback (id=${fetchId}). Cost for this call will be 0.`,
  );
  return {
    id: fetchId,
    name: fetchId,
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
