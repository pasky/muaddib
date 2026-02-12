import { PiAiModelAdapter } from "../models/pi-ai-model-adapter.js";
import { parseModelSpec } from "../models/model-spec.js";

export function resolveRefusalFallbackModel(
  config: Record<string, unknown>,
  options: {
    modelAdapter?: PiAiModelAdapter;
  } = {},
): string | undefined {
  const routerConfig = asRecord(config.router);
  const rawFallbackModel = routerConfig?.refusal_fallback_model;

  if (rawFallbackModel === undefined || rawFallbackModel === null) {
    return undefined;
  }

  if (typeof rawFallbackModel !== "string" || rawFallbackModel.trim().length === 0) {
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
