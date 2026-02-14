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
import {
  getOverriddenProviders,
  normalizeProviderOverrideOptions,
  resolveProviderOverrideModel,
  type ProviderOverrideOptions,
} from "./provider-overrides.js";

export class PiAiModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiAiModelResolutionError";
  }
}

export interface PiAiModelAdapterOptions extends ProviderOverrideOptions {
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
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
 */
export class PiAiModelAdapter {
  private readonly providerOverrideOptions;
  private readonly getApiKey;

  constructor(options: PiAiModelAdapterOptions = {}) {
    this.providerOverrideOptions = normalizeProviderOverrideOptions(options);
    this.getApiKey = options.getApiKey;
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

    const providerOverrideModel = resolveProviderOverrideModel(
      spec.provider,
      spec.modelId,
      this.providerOverrideOptions,
    );
    if (providerOverrideModel) {
      return {
        spec,
        model: providerOverrideModel,
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
          apiKey: options.getApiKey
            ? await options.getApiKey(resolved.spec.provider)
            : this.getApiKey
              ? await this.getApiKey(resolved.spec.provider)
              : undefined,
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
}

export function createPiAiModelAdapterFromConfig(
  config: MuaddibConfig,
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined,
): PiAiModelAdapter {
  return new PiAiModelAdapter({
    deepseekBaseUrl: config.getProvidersConfig().deepseek?.baseUrl,
    getApiKey,
  });
}

export function resolvePiAiModel(modelSpec: string): Model<Api> {
  return new PiAiModelAdapter().resolve(modelSpec).model;
}

function getSupportedProviders(): Set<string> {
  const providers = new Set<string>(getProviders() as string[]);
  for (const provider of getOverriddenProviders()) {
    providers.add(provider);
  }

  return providers;
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
