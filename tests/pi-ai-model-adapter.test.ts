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

  it("resolves deepseek provider via anthropic-compatible model wiring", () => {
    const resolved = adapter.resolve("deepseek:deepseek-reasoner");

    expect(resolved.spec.provider).toBe("deepseek");
    expect(resolved.model.provider).toBe("deepseek");
    expect(resolved.model.api).toBe("anthropic-messages");
    expect(resolved.model.baseUrl).toBe("https://api.deepseek.com/anthropic");
  });

  it("resolves deepseek model with hardcoded base URL", () => {
    const a = new PiAiModelAdapter({});

    const resolved = a.resolve("deepseek:deepseek-chat");
    expect(resolved.model.baseUrl).toBe("https://api.deepseek.com/anthropic");
  });

  it("throws explicit error for unknown provider", () => {
    expect(() => adapter.resolve("nonexistent-provider:model")).toThrow(PiAiModelResolutionError);
    expect(() => adapter.resolve("nonexistent-provider:model")).toThrow("Unknown provider");
  });

  it("throws explicit error for unknown model under a known provider", () => {
    expect(() => adapter.resolve("openai:not-a-real-model")).toThrow(PiAiModelResolutionError);
    expect(() => adapter.resolve("openai:not-a-real-model")).toThrow("Unknown model");
  });
});
