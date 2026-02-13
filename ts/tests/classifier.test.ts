import { describe, expect, it, vi } from "vitest";

import { createModeClassifier } from "../src/rooms/command/classifier.js";

const commandConfig = {
  history_size: 40,
  modes: {
    serious: {
      model: "openai:gpt-4o-mini",
      triggers: {
        "!s": {},
      },
    },
  },
  mode_classifier: {
    model: "openai:gpt-4o-mini",
    labels: {
      EASY_SERIOUS: "!s",
      SARCASTIC: "!d",
    },
    fallback_label: "EASY_SERIOUS",
    prompt: "Classify: {message}",
  },
};

describe("createModeClassifier", () => {
  it("returns best label based on completion text", async () => {
    const classifier = createModeClassifier(commandConfig as any, {
      completeFn: async () => ({
        role: "assistant",
        content: [{ type: "text", text: "SARCASTIC" }],
        api: "openai-completions",
        provider: "openai",
        model: "gpt-4o-mini",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      }),
    });

    const label = await classifier([{ role: "user", content: "<nick> tell joke" }]);
    expect(label).toBe("SARCASTIC");
  });

  it("uses configured classifier prompt with message substitution", async () => {
    let seenSystemPrompt = "";

    const classifier = createModeClassifier(commandConfig as any, {
      completeFn: async (_model, context) => {
        seenSystemPrompt = context.systemPrompt ?? "";
        return {
          role: "assistant",
          content: [{ type: "text", text: "EASY_SERIOUS" }],
          api: "openai-completions",
          provider: "openai",
          model: "gpt-4o-mini",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
      },
    });

    await classifier([{ role: "user", content: "<nick> tell joke" }]);

    expect(seenSystemPrompt).toContain("Classify: tell joke");
    expect(seenSystemPrompt).toContain("exactly one classifier label token");
  });

  it("logs warning when classifier response does not contain any known labels", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const classifier = createModeClassifier(commandConfig as any, {
      logger,
      completeFn: async () => ({
        role: "assistant",
        content: [{ type: "text", text: "not-a-label" }],
        api: "openai-completions",
        provider: "openai",
        model: "gpt-4o-mini",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      }),
    });

    const label = await classifier([{ role: "user", content: "hello" }]);

    expect(label).toBe("EASY_SERIOUS");
    expect(logger.warn).toHaveBeenCalledWith(
      "Invalid mode classification response",
      "response=not-a-label",
    );
  });

  it("falls back when completion fails and logs error severity", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const classifier = createModeClassifier(commandConfig as any, {
      logger,
      completeFn: async () => {
        throw new Error("failure");
      },
    });

    const label = await classifier([{ role: "user", content: "hello" }]);
    expect(label).toBe("EASY_SERIOUS");
    expect(logger.error).toHaveBeenCalledWith("Error classifying mode", expect.any(Error));
  });
});
