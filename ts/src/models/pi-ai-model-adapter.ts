import { getModel, getProviders, type Api, type KnownProvider, type Model } from "@mariozechner/pi-ai";

import { parseModelSpec, type ModelSpec } from "./model-spec.js";

export class PiAiModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiAiModelResolutionError";
  }
}

export interface ResolvedPiAiModel {
  spec: ModelSpec;
  model: Model<Api>;
}

/**
 * Adapter that enforces strict provider:model specs and resolves them via pi-ai's model registry.
 */
export class PiAiModelAdapter {
  resolve(modelSpec: string): ResolvedPiAiModel {
    const spec = parseModelSpec(modelSpec);
    const providers = new Set<string>(getProviders() as string[]);

    if (!providers.has(spec.provider)) {
      const availableProviders = Array.from(providers).sort().join(", ");
      throw new PiAiModelResolutionError(
        `Unknown provider '${spec.provider}' in model '${spec.raw}'. Available providers: ${availableProviders}`,
      );
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
}

export function resolvePiAiModel(modelSpec: string): Model<Api> {
  return new PiAiModelAdapter().resolve(modelSpec).model;
}
