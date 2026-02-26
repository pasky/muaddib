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

  it("parses provider routing from # suffix", () => {
    const spec = parseModelSpec("openrouter:moonshotai/kimi-k2#baseten/fp4,moonshotai/int4");

    expect(spec.provider).toBe("openrouter");
    expect(spec.modelId).toBe("moonshotai/kimi-k2");
    expect(spec.providerRouting).toEqual(["baseten/fp4", "moonshotai/int4"]);
  });

  it("parses single provider routing slug", () => {
    const spec = parseModelSpec("openrouter:anthropic/claude-sonnet-4#anthropic");

    expect(spec.modelId).toBe("anthropic/claude-sonnet-4");
    expect(spec.providerRouting).toEqual(["anthropic"]);
  });

  it("ignores empty # suffix", () => {
    const spec = parseModelSpec("openrouter:some/model#");

    expect(spec.modelId).toBe("some/model");
    expect(spec.providerRouting).toBeUndefined();
  });

  it("throws when model id before # is empty", () => {
    expect(() => parseModelSpec("openrouter:#baseten")).toThrow("empty model segment");
  });

  it("sets no providerRouting when # is absent", () => {
    const spec = parseModelSpec("openrouter:google/gemini-3-flash");

    expect(spec.providerRouting).toBeUndefined();
  });
});
