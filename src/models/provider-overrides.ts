import type { Api, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";

import { piAiModels } from "./pi-ai-models.js";

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

export function getOverriddenProviders(): string[] {
  return [OPENROUTER_PROVIDER];
}

export function resolveProviderOverrideModel(
  provider: string,
  modelId: string,
  providerRouting?: string[],
): Model<Api> | undefined {
  if (provider === OPENROUTER_PROVIDER) {
    return resolveOpenRouterModel(modelId, providerRouting);
  }

  return undefined;
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
    for (const tag of providerRouting) {
      const match = payload.endpoints.find((e) => e.tag === tag);
      if (match) return match;
    }
    console.warn(
      `OpenRouter model '${payload.id}' has no endpoint matching provider routing '${providerRouting.join(",")}' ` +
        `(available: ${payload.endpoints.map((e) => e.tag).join(", ")}); using default endpoint.`,
    );
  }
  return payload.endpoints.find((e) => e.status >= 0) ?? payload.endpoints[0];
}

/**
 * Context/output limits the request must fit. Pinned routing may land on any of the
 * listed endpoints; unpinned routing may land on any active one, so take the minimum
 * across that pool - otherwise e.g. DeepInfra's advertised 943718 max_completion_tokens
 * makes OpenRouter skip or 400 on endpoints capped at 65536/131072.
 */
function endpointLimits(
  payload: OpenRouterEndpointsPayload,
  endpoint: OpenRouterEndpoint,
  providerRouting: string[] | undefined,
): { contextWindow: number; maxTokens: number } {
  const pinnedPool = providerRouting?.length
    ? payload.endpoints.filter((e) => providerRouting.includes(e.tag))
    : [];
  const active = payload.endpoints.filter((e) => e.status >= 0);
  const pool = pinnedPool.length > 0 ? pinnedPool : active.length > 0 ? active : [endpoint];
  const completionCaps = pool
    .map((e) => e.max_completion_tokens)
    .filter((n): n is number => n !== null);
  return {
    contextWindow: Math.min(...pool.map((e) => e.context_length)),
    maxTokens: completionCaps.length > 0 ? Math.min(...completionCaps) : 8_192,
  };
}

function applyRoutingCompat(
  model: Model<Api>,
  routingCompat: OpenAICompletionsCompat | undefined,
): Model<Api> {
  if (!routingCompat) return model;
  if (model.api === "openai-completions") {
    return {
      ...model,
      compat: { ...(model.compat as OpenAICompletionsCompat | undefined), ...routingCompat },
    };
  }
  // OpenRouter provider routing is only supported on openai-completions; drop
  // non-OpenAI compat fields (e.g. anthropic-messages) when switching APIs.
  return {
    ...model,
    api: "openai-completions",
    baseUrl: OPENROUTER_BASE_URL,
    compat: routingCompat,
  };
}

function buildModelFromEndpoint(
  modelId: string,
  payload: OpenRouterEndpointsPayload,
  endpoint: OpenRouterEndpoint,
  routingCompat: OpenAICompletionsCompat | undefined,
  providerRouting: string[] | undefined,
  known: Model<Api> | undefined,
): Model<Api> {
  const endpointOverrides = {
    id: modelId,
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
    ...endpointLimits(payload, endpoint, providerRouting),
  };
  const base: Model<Api> = known
    ? { ...known, ...endpointOverrides }
    : {
        ...endpointOverrides,
        name: modelId,
        api: "openai-completions",
        provider: OPENROUTER_PROVIDER,
        baseUrl: OPENROUTER_BASE_URL,
      };
  return applyRoutingCompat(base, routingCompat);
}

function resolveOpenRouterModel(modelId: string, providerRouting?: string[]): Model<Api> | undefined {
  const routingCompat: OpenAICompletionsCompat | undefined = providerRouting?.length
    ? {
        openRouterRouting: {
          only: providerRouting,
          ...(providerRouting.length > 1 ? { order: providerRouting } : {}),
        },
      }
    : undefined;

  // Anthropic-style hyphenated versions (`claude-opus-4-6`) map to dotted form on OpenRouter
  // (`anthropic/claude-opus-4.6`). Try the raw id first, then the normalized form.
  const normalized = normalizeOpenRouterModelId(modelId);
  const candidates = normalized !== modelId ? [modelId, normalized] : [modelId];

  // Look up the pi-ai / remote-catalog entry so warm endpoint overlays preserve
  // thinkingLevelMap, compat, api, etc. instead of discarding them.
  let known: Model<Api> | undefined;
  for (const candidate of candidates) {
    known = piAiModels.getModel(OPENROUTER_PROVIDER, candidate);
    if (known) break;
  }

  // Endpoint cache is the source of truth for pricing. Use per-endpoint pricing when
  // providerRouting is set so we don't inherit the misleading "min across endpoints"
  // pricing that OpenRouter surfaces on the top-level /models entry.
  for (const candidate of candidates) {
    const cached = endpointsCache.get(candidate);
    if (cached) {
      const endpoint = pickEndpoint(cached, providerRouting);
      if (endpoint) {
        return buildModelFromEndpoint(
          candidate,
          cached,
          endpoint,
          routingCompat,
          providerRouting,
          known,
        );
      }
    }
  }

  // Kick off a lazy fetch so subsequent calls resolve with real pricing.
  // Prefer the normalized form since that's what OpenRouter serves.
  const fetchId = candidates[candidates.length - 1];
  void fetchOpenRouterEndpoints(fetchId);

  // Cache cold: fall back to pi-ai's static/remote registry entry if available.
  if (known) {
    return applyRoutingCompat(known, routingCompat);
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
    compat: routingCompat,
  };
}
