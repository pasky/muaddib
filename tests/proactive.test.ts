import { describe, expect, it, vi } from "vitest";
import type { Message, AssistantMessage } from "@mariozechner/pi-ai";

import {
  evaluateProactiveInterjection,
  type ProactiveConfig,
  type ProactiveEvaluatorOptions,
} from "../src/rooms/command/proactive.js";
import { createStubAssistantFields } from "../src/history/chat-history-store.js";

function userMsg(content: string): Message {
  return { role: "user", content, timestamp: 0 };
}

function assistantMsg(content: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    ...createStubAssistantFields(),
    timestamp: 0,
  };
}

const baseConfig: ProactiveConfig = {
  interjecting: ["irc.example.com#test"],
  debounceSeconds: 5,
  historySize: 20,
  rateLimit: 10,
  ratePeriod: 3600,
  interjectThreshold: 7,
  models: {
    validation: ["openai:gpt-4o-mini"],
    serious: "openai:gpt-4o",
  },
  prompts: {
    interject: "Evaluate: {message}",
    seriousExtra: "",
  },
};

const baseOptions: ProactiveEvaluatorOptions = {
  modelAdapter: {
    completeSimple: vi.fn(),
  } as any,
  mynick: "TestBot",
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
};

describe("evaluateProactiveInterjection", () => {
  it("returns false with empty context", async () => {
    const result = await evaluateProactiveInterjection(baseConfig, [], baseOptions);
    expect(result.shouldInterject).toBe(false);
    expect(result.reason).toContain("No context");
  });

  it("skips evaluation when last message is from the bot (assistant)", async () => {
    const context: Message[] = [
      userMsg("[14:30] <alice> hey bot, what's up?"),
      assistantMsg("[14:30] <TestBot> Not much, just chilling."),
    ];

    const completeSimple = vi.fn();
    const options = { ...baseOptions, modelAdapter: { completeSimple } as any };

    const result = await evaluateProactiveInterjection(baseConfig, context, options);

    expect(result.shouldInterject).toBe(false);
    expect(result.reason).toContain("bot");
    // The validation model should never be called.
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("proceeds with evaluation when last message is from a user", async () => {
    const context: Message[] = [
      assistantMsg("[14:28] <TestBot> previous response"),
      userMsg("[14:30] <alice> how do I configure systemd?"),
    ];

    const mockResponse: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[1. Technical question about systemd. 2. Yes. 3. Could explain Type=simple]: 8/10" }],
      ...createStubAssistantFields(),
      timestamp: Date.now(),
    };

    const completeSimple = vi.fn().mockResolvedValue(mockResponse);
    const options = { ...baseOptions, modelAdapter: { completeSimple } as any };

    const result = await evaluateProactiveInterjection(baseConfig, context, options);

    // Validation model should have been called.
    expect(completeSimple).toHaveBeenCalled();
    expect(result.shouldInterject).toBe(true);
  });
});
