import { describe, expect, it, vi } from "vitest";

import { ContextReducerTs } from "../src/rooms/command/context-reducer.js";

function assistantTextMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

describe("ContextReducerTs", () => {
  it("isConfigured returns false when model or prompt is missing", () => {
    expect(new ContextReducerTs().isConfigured).toBe(false);
    expect(new ContextReducerTs({ config: { model: "openai:gpt-4o-mini" } }).isConfigured).toBe(false);
    expect(new ContextReducerTs({ config: { prompt: "Reduce this" } }).isConfigured).toBe(false);
  });

  it("isConfigured returns true when both model and prompt are set", () => {
    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce this" },
    });
    expect(reducer.isConfigured).toBe(true);
  });

  it("reduce returns context minus last message when not configured", async () => {
    const reducer = new ContextReducerTs();
    const context = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "latest" },
    ];

    const result = await reducer.reduce(context, "system prompt");
    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("reduce returns empty array when context has no messages to reduce", async () => {
    const completeFn = vi.fn();
    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      completeFn,
    });

    const result = await reducer.reduce([{ role: "user", content: "only message" }], "sys");
    expect(result).toEqual([]);
    expect(completeFn).not.toHaveBeenCalled();
  });

  it("reduce parses [USER]/[ASSISTANT] formatted LLM response", async () => {
    const completeFn = vi.fn(async () =>
      assistantTextMessage("[USER]: summarized question\n[ASSISTANT]: summarized answer"),
    );

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Condense the conversation" },
      completeFn,
    });

    const context = [
      { role: "user", content: "long question" },
      { role: "assistant", content: "long answer" },
      { role: "user", content: "follow up" },
    ];

    const result = await reducer.reduce(context, "agent system prompt");
    expect(result).toEqual([
      { role: "user", content: "summarized question" },
      { role: "assistant", content: "summarized answer" },
    ]);

    // Verify the formatted context sent to the LLM
    const firstCall = completeFn.mock.calls[0] as any[];
    const sentMessages = firstCall[1].messages;
    expect(sentMessages[0].content).toContain("## AGENT SYSTEM PROMPT");
    expect(sentMessages[0].content).toContain("agent system prompt");
    expect(sentMessages[0].content).toContain("[USER]: long question");
    expect(sentMessages[0].content).toContain("[ASSISTANT]: long answer");
    expect(sentMessages[0].content).toContain("## TRIGGERING INPUT");
    expect(sentMessages[0].content).toContain("follow up");

    // Verify system prompt and options
    expect(firstCall[1].systemPrompt).toBe("Condense the conversation");
    expect(firstCall[2]).toMatchObject({ maxTokens: 2048 });
  });

  it("reduce wraps plain text response in context_summary tag", async () => {
    const completeFn = vi.fn(async () =>
      assistantTextMessage("The user asked about cats and the assistant explained feline behavior."),
    );

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Summarize" },
      completeFn,
    });

    const context = [
      { role: "user", content: "tell me about cats" },
      { role: "assistant", content: "cats are great" },
      { role: "user", content: "more" },
    ];

    const result = await reducer.reduce(context, "sys");
    expect(result).toEqual([
      {
        role: "user",
        content: "<context_summary>The user asked about cats and the assistant explained feline behavior.</context_summary>",
      },
    ]);
  });

  it("reduce falls back to sliced context when LLM returns empty response", async () => {
    const completeFn = vi.fn(async () => assistantTextMessage(""));

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      completeFn,
    });

    const context = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];

    const result = await reducer.reduce(context, "sys");
    expect(result).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
  });

  it("reduce falls back to sliced context when LLM call throws", async () => {
    const completeFn = vi.fn(async () => {
      throw new Error("API error");
    });

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      completeFn,
    });

    const context = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ];

    const result = await reducer.reduce(context, "sys");
    expect(result).toEqual([{ role: "user", content: "a" }]);
  });

  it("reduce resolves API key via getApiKey callback", async () => {
    const getApiKey = vi.fn(async (provider: string) => (provider === "openai" ? "sk-test" : undefined));
    const completeFn = vi.fn(async () => assistantTextMessage("[USER]: hi"));

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      completeFn,
      getApiKey,
    });

    await reducer.reduce(
      [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ],
      "sys",
    );

    expect(getApiKey).toHaveBeenCalledWith("openai");
    const firstCall = completeFn.mock.calls[0] as any[];
    expect(firstCall[2]).toMatchObject({ apiKey: "sk-test" });
  });

  it("reduce handles multi-turn parsed response correctly", async () => {
    const completeFn = vi.fn(async () =>
      assistantTextMessage("[USER]: question one\n[ASSISTANT]: answer one\n[USER]: question two"),
    );

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      completeFn,
    });

    const result = await reducer.reduce(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "d" },
        { role: "user", content: "e" },
      ],
      "sys",
    );

    expect(result).toEqual([
      { role: "user", content: "question one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "question two" },
    ]);
  });

  it("reduce skips empty entries when LLM omits content for a role", async () => {
    const completeFn = vi.fn(async () =>
      assistantTextMessage("[USER]: \n[ASSISTANT]: actual content"),
    );

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      completeFn,
    });

    const result = await reducer.reduce(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      "sys",
    );

    expect(result).toEqual([{ role: "assistant", content: "actual content" }]);
  });
});
