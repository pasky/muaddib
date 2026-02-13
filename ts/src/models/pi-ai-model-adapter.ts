import { getModel, getProviders, type Api, type KnownProvider, type Model } from "@mariozechner/pi-ai";

import { parseModelSpec, type ModelSpec } from "./model-spec.js";

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

export class PiAiModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiAiModelResolutionError";
  }
}

export interface PiAiModelAdapterOptions {
  deepseekBaseUrl?: string;
}

export interface ResolvedPiAiModel {
  spec: ModelSpec;
  model: Model<Api>;
}

/**
 * Adapter that enforces strict provider:model specs and resolves them via pi-ai's model registry.
 *
 * DeepSeek is intentionally handled as an Anthropic-compatible provider in the TS runtime,
 * mirroring Python's dedicated DeepSeek client behavior.
 */
export class PiAiModelAdapter {
  private readonly deepseekBaseUrl: string;

  constructor(options: PiAiModelAdapterOptions = {}) {
    this.deepseekBaseUrl = normalizeDeepSeekBaseUrl(options.deepseekBaseUrl);
  }

  resolve(modelSpec: string): ResolvedPiAiModel {
    const spec = parseModelSpec(modelSpec);
    const providers = getSupportedProviders();

    if (!providers.has(spec.provider)) {
      const availableProviders = Array.from(providers).sort().join(", ");
      throw new PiAiModelResolutionError(
        `Unknown provider '${spec.provider}' in model '${spec.raw}'. Available providers: ${availableProviders}`,
      );
    }

    if (spec.provider === DEEPSEEK_PROVIDER) {
      return {
        spec,
        model: this.resolveDeepSeekModel(spec.modelId),
      };
    }

    const model = getModel(spec.provider as KnownProvider, spec.modelId as never) as
      | Model<Api>
      | undefined;

    if (!model) {
      throw new PiAiModelResolutionError(
        `Unknown model '${spec.modelId}' for provider '${spec.provider}' in '${spec.raw}'.`,
      );
    }

    return { spec, model };
  }

  private resolveDeepSeekModel(modelId: string): Model<Api> {
    const pricing = DEEPSEEK_PRICING_BY_MODEL[modelId] ?? {
      input: 0,
      output: 0,
    };

    return {
      id: modelId,
      name: modelId,
      api: "anthropic-messages",
      provider: DEEPSEEK_PROVIDER,
      baseUrl: this.deepseekBaseUrl,
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
}

export function createPiAiModelAdapterFromConfig(
  config: Record<string, unknown>,
): PiAiModelAdapter {
  return new PiAiModelAdapter({
    deepseekBaseUrl: readDeepSeekBaseUrlFromConfig(config),
  });
}

export function resolvePiAiModel(modelSpec: string): Model<Api> {
  return new PiAiModelAdapter().resolve(modelSpec).model;
}

function getSupportedProviders(): Set<string> {
  const providers = new Set<string>(getProviders() as string[]);
  providers.add(DEEPSEEK_PROVIDER);
  return providers;
}

function readDeepSeekBaseUrlFromConfig(config: Record<string, unknown>): string | undefined {
  const providers = asRecord(config.providers);
  const deepseekConfig = asRecord(providers?.[DEEPSEEK_PROVIDER]);

  const rawUrl = deepseekConfig?.url ?? deepseekConfig?.base_url;
  if (typeof rawUrl !== "string") {
    return undefined;
  }

  const trimmed = rawUrl.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
