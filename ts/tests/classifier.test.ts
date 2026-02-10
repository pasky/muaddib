import { describe, expect, it } from "vitest";

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

  it("falls back when completion fails", async () => {
    const classifier = createModeClassifier(commandConfig as any, {
      completeFn: async () => {
        throw new Error("failure");
      },
    });

    const label = await classifier([{ role: "user", content: "hello" }]);
    expect(label).toBe("EASY_SERIOUS");
  });
});
