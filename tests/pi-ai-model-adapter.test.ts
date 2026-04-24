import { describe, expect, it } from "vitest";

import {
  PiAiModelAdapter,
  PiAiModelResolutionError,
} from "../src/models/pi-ai-model-adapter.js";

describe("PiAiModelAdapter", () => {
  const adapter = new PiAiModelAdapter();

  it("resolves a known provider:model spec via pi-ai registry", () => {
    const resolved = adapter.resolve("openai:gpt-4o-mini");

    expect(resolved.spec.provider).toBe("openai");
    expect(resolved.spec.modelId).toBe("gpt-4o-mini");
    expect(resolved.model.provider).toBe("openai");
    expect(resolved.model.id).toBe("gpt-4o-mini");
  });

  it("resolves DeepSeek V4 Flash via pi-ai registry", () => {
    const resolved = adapter.resolve("deepseek:deepseek-v4-flash");
    const compat = resolved.model.compat as { thinkingFormat?: string } | undefined;

    expect(resolved.spec.provider).toBe("deepseek");
    expect(resolved.model.id).toBe("deepseek-v4-flash");
    expect(resolved.model.provider).toBe("deepseek");
    expect(resolved.model.api).toBe("openai-completions");
    expect(resolved.model.baseUrl).toBe("https://api.deepseek.com");
    expect(compat?.thinkingFormat).toBe("deepseek");
    expect(resolved.model.reasoning).toBe(true);
  });

  it("resolves DeepSeek V4 Pro with current pricing and limits", () => {
    const resolved = adapter.resolve("deepseek:deepseek-v4-pro");
    const compat = resolved.model.compat as { thinkingFormat?: string } | undefined;

    expect(resolved.spec.provider).toBe("deepseek");
    expect(resolved.model.id).toBe("deepseek-v4-pro");
    expect(resolved.model.provider).toBe("deepseek");
    expect(resolved.model.api).toBe("openai-completions");
    expect(resolved.model.baseUrl).toBe("https://api.deepseek.com");
    expect(compat?.thinkingFormat).toBe("deepseek");
    expect(resolved.model.reasoning).toBe(true);
    expect(resolved.model.cost.input).toBe(1.74);
    expect(resolved.model.cost.output).toBe(3.48);
    expect(resolved.model.cost.cacheRead).toBe(0.145);
    expect(resolved.model.contextWindow).toBe(1_000_000);
    expect(resolved.model.maxTokens).toBe(384_000);
  });

  it("throws explicit error for unknown provider", () => {
    expect(() => adapter.resolve("nonexistent-provider:model")).toThrow(PiAiModelResolutionError);
    expect(() => adapter.resolve("nonexistent-provider:model")).toThrow("Unknown provider");
  });

  it("throws explicit error for unknown model under a known provider", () => {
    expect(() => adapter.resolve("openai:not-a-real-model")).toThrow(PiAiModelResolutionError);
    expect(() => adapter.resolve("openai:not-a-real-model")).toThrow("Unknown model");
  });

  it("resolves known openrouter model via static registry", () => {
    const resolved = adapter.resolve("openrouter:openrouter/auto");

    expect(resolved.spec.provider).toBe("openrouter");
    expect(resolved.model.provider).toBe("openrouter");
    expect(resolved.model.api).toBe("openai-completions");
  });

  it("resolves unknown openrouter model via dynamic fallback (zero-cost if cache not ready)", () => {
    // In tests the background fetch may not have landed; either way the model must resolve.
    // Note: digit-hyphen-digit normalization converts 3-1 to 3.1 in the fallback ID.
    const resolved = adapter.resolve("openrouter:google/gemini-3-1-pro-preview");

    expect(resolved.spec.provider).toBe("openrouter");
    expect(resolved.model.provider).toBe("openrouter");
    expect(resolved.model.id).toBe("google/gemini-3.1-pro-preview");
    expect(resolved.model.api).toBe("openai-completions");
    expect(resolved.model.baseUrl).toBe("https://openrouter.ai/api/v1");
  });
});
