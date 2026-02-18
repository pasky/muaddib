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

import type { AuthStorage } from "@mariozechner/pi-coding-agent";

import type { Logger } from "../app/logging.js";
import { parseModelSpec, type ModelSpec } from "./model-spec.js";
import {
  getOverriddenProviders,
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
  authStorage?: AuthStorage;
}

export interface ResolvedPiAiModel {
  spec: ModelSpec;
  model: Model<Api>;
}

export interface CompleteSimpleOptions {
  callType?: string;
  logger?: Logger;
  authStorage?: AuthStorage;
  maxChars?: number;
  streamOptions?: Omit<SimpleStreamOptions, "apiKey" | "onPayload">;
}

let supportedProviders: Set<string> | undefined;

function getSupportedProviders(): Set<string> {
  if (!supportedProviders) {
    supportedProviders = new Set<string>(getProviders() as string[]);
    for (const provider of getOverriddenProviders()) {
      supportedProviders.add(provider);
    }
  }
  return supportedProviders;
}

/**
 * Adapter that enforces strict provider:model specs and resolves them via pi-ai's model registry.
 */
export class PiAiModelAdapter {
  private readonly options: PiAiModelAdapterOptions;

  constructor(options: PiAiModelAdapterOptions = {}) {
    this.options = options;
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
      this.options,
    );
    if (providerOverrideModel) {
      return { spec, model: providerOverrideModel };
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
          apiKey: options.authStorage
            ? await options.authStorage.getApiKey(resolved.spec.provider)
            : this.options.authStorage
              ? await this.options.authStorage.getApiKey(resolved.spec.provider)
              : undefined,
          onPayload: (payload: unknown) => {
            logger?.debug(`llm_io payload ${callType}`, truncateJson(payload, maxChars));
          },
        },
      );

      logger?.debug(`llm_io response ${callType}`, truncateJson(response, maxChars));
      return response;
    } catch (error) {
      logger?.error(`llm_io error ${callType}`, truncateJson({ error: String(error) }, maxChars));
      throw error;
    }
  }
}

function truncateJson(value: unknown, maxChars: number): string {
  const json = JSON.stringify(value, null, 2) ?? "[unserializable]";
  if (json.length <= maxChars) {
    return json;
  }
  return `${json.slice(0, maxChars)}...[truncated ${json.length - maxChars} chars]`;
}
