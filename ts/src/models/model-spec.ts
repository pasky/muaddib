export interface ModelSpec {
  provider: string;
  modelId: string;
  raw: string;
}

export type ModelSpecErrorCode =
  | "MODEL_SPEC_EMPTY"
  | "MODEL_SPEC_MISSING_COLON"
  | "MODEL_SPEC_EMPTY_PROVIDER"
  | "MODEL_SPEC_EMPTY_MODEL";

export class ModelSpecError extends Error {
  readonly code: ModelSpecErrorCode;

  constructor(code: ModelSpecErrorCode, message: string) {
    super(message);
    this.name = "ModelSpecError";
    this.code = code;
  }
}

const MODEL_SPEC_EXAMPLE = "provider:model";

export function parseModelSpec(input: string): ModelSpec {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ModelSpecError(
      "MODEL_SPEC_EMPTY",
      `Model spec is required and must be fully qualified as ${MODEL_SPEC_EXAMPLE}.`,
    );
  }

  const colonIndex = raw.indexOf(":");
  if (colonIndex < 0) {
    throw new ModelSpecError(
      "MODEL_SPEC_MISSING_COLON",
      `Model '${raw}' must be fully qualified as ${MODEL_SPEC_EXAMPLE}.`,
    );
  }

  const provider = raw.slice(0, colonIndex).trim();
  const modelId = raw.slice(colonIndex + 1).trim();

  if (!provider) {
    throw new ModelSpecError(
      "MODEL_SPEC_EMPTY_PROVIDER",
      `Model '${raw}' has an empty provider segment; expected ${MODEL_SPEC_EXAMPLE}.`,
    );
  }

  if (!modelId) {
    throw new ModelSpecError(
      "MODEL_SPEC_EMPTY_MODEL",
      `Model '${raw}' has an empty model segment; expected ${MODEL_SPEC_EXAMPLE}.`,
    );
  }

  return { provider, modelId, raw };
}
