import { PiAiModelAdapter } from "../models/pi-ai-model-adapter.js";
import { parseModelSpec } from "../models/model-spec.js";
import { MuaddibConfig } from "../config/muaddib-config.js";

export function resolveRefusalFallbackModel(
  config: MuaddibConfig,
  options: {
    modelAdapter?: PiAiModelAdapter;
  } = {},
): string | undefined {
  const rawFallbackModel = config.getRouterConfig().refusalFallbackModel;

  if (rawFallbackModel === undefined) {
    return undefined;
  }

  if (rawFallbackModel.trim().length === 0) {
    throw new Error(
      "router.refusal_fallback_model must be a non-empty string fully qualified as provider:model.",
    );
  }

  const trimmedModel = rawFallbackModel.trim();

  let normalizedModel: string;
  try {
    const spec = parseModelSpec(trimmedModel);
    normalizedModel = `${spec.provider}:${spec.modelId}`;
  } catch (error) {
    throw new Error(
      `Invalid router.refusal_fallback_model '${trimmedModel}': ${stringifyError(error)}`,
    );
  }

  const adapter = options.modelAdapter ?? new PiAiModelAdapter();

  try {
    adapter.resolve(normalizedModel);
  } catch (error) {
    throw new Error(
      `Unsupported router.refusal_fallback_model '${normalizedModel}': ${stringifyError(error)}`,
    );
  }

  return normalizedModel;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
