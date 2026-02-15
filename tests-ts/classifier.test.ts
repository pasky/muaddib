import { describe, expect, it, vi } from "vitest";

import { createModeClassifier } from "../src/rooms/command/classifier.js";

const commandConfig = {
  historySize: 40,
  modes: {
    serious: {
      model: "openai:gpt-4o-mini",
      triggers: {
        "!s": {},
      },
    },
  },
  modeClassifier: {
    model: "openai:gpt-4o-mini",
    labels: {
      EASY_SERIOUS: "!s",
      SARCASTIC: "!d",
    },
    fallbackLabel: "EASY_SERIOUS",
    prompt: "Classify: {message}",
  },
};

describe("createModeClassifier", () => {
  it("returns best label based on completion text", async () => {
    const modelAdapter = {
      completeSimple: vi.fn(async () => ({
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
      })),
    } as any;

    const classifier = createModeClassifier(commandConfig as any, {
      modelAdapter,
    });

    const label = await classifier([{ role: "user", content: "<nick> tell joke" }]);
    expect(label).toBe("SARCASTIC");
  });

  it("uses configured classifier prompt with message substitution", async () => {
    let seenSystemPrompt = "";

    const modelAdapter = {
      completeSimple: vi.fn(async (_modelSpec: string, context: { systemPrompt?: string }) => {
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
      }),
    } as any;

    const classifier = createModeClassifier(commandConfig as any, {
      modelAdapter,
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

    const modelAdapter = {
      completeSimple: vi.fn(async () => ({
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
      })),
    } as any;

    const classifier = createModeClassifier(commandConfig as any, {
      logger,
      modelAdapter,
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

    const modelAdapter = {
      completeSimple: vi.fn(async () => {
        throw new Error("failure");
      }),
    } as any;

    const classifier = createModeClassifier(commandConfig as any, {
      logger,
      modelAdapter,
    });

    const label = await classifier([{ role: "user", content: "hello" }]);
    expect(label).toBe("EASY_SERIOUS");
    expect(logger.error).toHaveBeenCalledWith("Error classifying mode", expect.any(Error));
  });
});
