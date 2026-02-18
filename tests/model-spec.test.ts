import { describe, expect, it } from "vitest";

import { ModelSpecError, parseModelSpec } from "../src/models/model-spec.js";

describe("parseModelSpec", () => {
  it("parses a fully qualified provider:model spec", () => {
    const spec = parseModelSpec("anthropic:claude-sonnet-4-20250514");

    expect(spec.provider).toBe("anthropic");
    expect(spec.modelId).toBe("claude-sonnet-4-20250514");
  });

  it("trims surrounding whitespace", () => {
    const spec = parseModelSpec("  openai:gpt-4o-mini  ");

    expect(spec.provider).toBe("openai");
    expect(spec.modelId).toBe("gpt-4o-mini");
  });

  it("throws explicit error when no colon is present", () => {
    expect(() => parseModelSpec("gpt-4o-mini")).toThrow(ModelSpecError);
    expect(() => parseModelSpec("gpt-4o-mini")).toThrow("must be fully qualified");
  });

  it("throws explicit error when provider is missing", () => {
    expect(() => parseModelSpec(":gpt-4o-mini")).toThrow(ModelSpecError);
    expect(() => parseModelSpec(":gpt-4o-mini")).toThrow("empty provider segment");
  });

  it("throws explicit error when model id is missing", () => {
    expect(() => parseModelSpec("openai:")).toThrow(ModelSpecError);
    expect(() => parseModelSpec("openai:")).toThrow("empty model segment");
  });
});
