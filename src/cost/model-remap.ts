import { parseModelSpec } from "../models/model-spec.js";

export function remapToOpenRouter(modelSpec: string): string {
  const parsed = parseModelSpec(modelSpec);
  if (parsed.provider === "openrouter") {
    return parsed.raw;
  }
  return `openrouter:${parsed.provider}/${parsed.modelId}`;
}
