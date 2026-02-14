import { MuaddibConfig } from "../config/muaddib-config.js";
import { PiAiModelAdapter } from "../models/pi-ai-model-adapter.js";
import { parseModelSpec } from "../models/model-spec.js";

export function resolvePersistenceSummaryModel(
  config: MuaddibConfig,
  options: {
    modelAdapter?: PiAiModelAdapter;
  } = {},
): string | undefined {
  const rawSummaryModel = config.getToolsConfig().summary?.model;

  if (rawSummaryModel === undefined || rawSummaryModel === null) {
    return undefined;
  }

  if (typeof rawSummaryModel !== "string" || rawSummaryModel.trim().length === 0) {
    throw new Error(
      "tools.summary.model must be a non-empty string fully qualified as provider:model.",
    );
  }

  const trimmedModel = rawSummaryModel.trim();

  let normalizedModel: string;
  try {
    const spec = parseModelSpec(trimmedModel);
    normalizedModel = `${spec.provider}:${spec.modelId}`;
  } catch (error) {
    throw new Error(`Invalid tools.summary.model '${trimmedModel}': ${stringifyError(error)}`);
  }

  const adapter = options.modelAdapter ?? new PiAiModelAdapter();

  try {
    adapter.resolve(normalizedModel);
  } catch (error) {
    throw new Error(
      `Unsupported tools.summary.model '${normalizedModel}': ${stringifyError(error)}`,
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
