import {
  completeSimple,
  getModel,
  getProviders,
  type Api,
  type AssistantMessage,
  type Context,
  type KnownProvider,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";

import { MuaddibConfig } from "../config/muaddib-config.js";
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

interface LlmTraceLogger {
  debug(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
}

export interface CompleteSimpleOptions {
  callType?: string;
  logger?: LlmTraceLogger;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  maxChars?: number;
  streamOptions?: Omit<SimpleStreamOptions, "apiKey" | "onPayload">;
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

  async completeSimple(modelSpec: string, context: Context, options: CompleteSimpleOptions = {}): Promise<AssistantMessage> {
    const resolved = this.resolve(modelSpec);
    const callType = options.callType ?? "llm_call";
    const logger = options.logger;
    const maxChars = Math.max(500, Math.floor(options.maxChars ?? 120_000));

    try {
      const response = await completeSimple(
        resolved.model,
        context,
        {
          ...(options.streamOptions ?? {}),
          apiKey: options.getApiKey ? await options.getApiKey(resolved.spec.provider) : undefined,
          onPayload: (payload: unknown) => {
            logger?.debug(`llm_io payload ${callType}`, safeJson(payload, maxChars));
          },
        },
      );

      logger?.debug(`llm_io response ${callType}`, safeJson(response, maxChars));
      return response;
    } catch (error) {
      logger?.error(`llm_io error ${callType}`, safeJson({ error: String(error) }, maxChars));
      throw error;
    }
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

export function createPiAiModelAdapterFromConfig(config: MuaddibConfig): PiAiModelAdapter {
  return new PiAiModelAdapter({
    deepseekBaseUrl: config.getProvidersConfig().deepseek?.baseUrl,
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

function safeJson(value: unknown, maxChars: number): string {
  try {
    return truncateForDebug(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return "[unserializable payload]";
  }
}

function truncateForDebug(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 24))}...[truncated ${value.length - maxChars} chars]`;
}
