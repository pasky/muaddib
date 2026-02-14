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
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
      { role: "user" as const, content: "latest" },
    ];

    const result = await reducer.reduce(context, "system prompt");
    expect(result).toEqual([
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ]);
  });

  it("reduce returns empty array when context has no messages to reduce", async () => {
    const modelAdapter = { completeSimple: vi.fn() } as any;
    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      modelAdapter,
    });

    const result = await reducer.reduce([{ role: "user" as const, content: "only message" }], "sys");
    expect(result).toEqual([]);
    expect(modelAdapter.completeSimple).not.toHaveBeenCalled();
  });

  it("reduce parses [USER]/[ASSISTANT] formatted LLM response", async () => {
    const modelAdapter = {
      completeSimple: vi.fn(async () => assistantTextMessage("[USER]: summarized question\n[ASSISTANT]: summarized answer")),
    } as any;

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Condense the conversation" },
      modelAdapter,
    });

    const context = [
      { role: "user" as const, content: "long question" },
      { role: "assistant" as const, content: "long answer" },
      { role: "user" as const, content: "follow up" },
    ];

    const result = await reducer.reduce(context, "agent system prompt");
    expect(result).toEqual([
      { role: "user" as const, content: "summarized question" },
      { role: "assistant" as const, content: "summarized answer" },
    ]);

    const firstCall = modelAdapter.completeSimple.mock.calls[0] as any[];
    const sentMessages = firstCall[1].messages;
    expect(sentMessages[0].content).toContain("## AGENT SYSTEM PROMPT");
    expect(sentMessages[0].content).toContain("agent system prompt");
    expect(sentMessages[0].content).toContain("[USER]: long question");
    expect(sentMessages[0].content).toContain("[ASSISTANT]: long answer");
    expect(sentMessages[0].content).toContain("## TRIGGERING INPUT");
    expect(sentMessages[0].content).toContain("follow up");

    expect(firstCall[1].systemPrompt).toBe("Condense the conversation");
    expect(firstCall[2]).toMatchObject({ streamOptions: { maxTokens: 2048 } });
  });

  it("reduce wraps plain text response in context_summary tag", async () => {
    const modelAdapter = {
      completeSimple: vi.fn(async () =>
        assistantTextMessage("The user asked about cats and the assistant explained feline behavior.")),
    } as any;

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Summarize" },
      modelAdapter,
    });

    const context = [
      { role: "user" as const, content: "tell me about cats" },
      { role: "assistant" as const, content: "cats are great" },
      { role: "user" as const, content: "more" },
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
    const modelAdapter = { completeSimple: vi.fn(async () => assistantTextMessage("")) } as any;

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      modelAdapter,
    });

    const context = [
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
      { role: "user" as const, content: "c" },
    ];

    const result = await reducer.reduce(context, "sys");
    expect(result).toEqual([
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
    ]);
  });

  it("reduce falls back to sliced context when LLM call throws", async () => {
    const modelAdapter = {
      completeSimple: vi.fn(async () => {
        throw new Error("API error");
      }),
    } as any;

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      modelAdapter,
    });

    const context = [
      { role: "user" as const, content: "a" },
      { role: "user" as const, content: "b" },
    ];

    const result = await reducer.reduce(context, "sys");
    expect(result).toEqual([{ role: "user" as const, content: "a" }]);
  });

  it("reduce resolves API key via getApiKey callback", async () => {
    const getApiKey = vi.fn(async (provider: string) => (provider === "openai" ? "sk-test" : undefined));
    const modelAdapter = { completeSimple: vi.fn(async () => assistantTextMessage("[USER]: hi")) } as any;

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      modelAdapter,
      getApiKey,
    });

    await reducer.reduce(
      [
        { role: "user" as const, content: "a" },
        { role: "user" as const, content: "b" },
      ],
      "sys",
    );

    const firstCall = modelAdapter.completeSimple.mock.calls[0] as any[];
    expect(firstCall[2]).toMatchObject({ getApiKey });
  });

  it("reduce handles multi-turn parsed response correctly", async () => {
    const modelAdapter = {
      completeSimple: vi.fn(async () =>
        assistantTextMessage("[USER]: question one\n[ASSISTANT]: answer one\n[USER]: question two")),
    } as any;

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      modelAdapter,
    });

    const result = await reducer.reduce(
      [
        { role: "user" as const, content: "a" },
        { role: "assistant" as const, content: "b" },
        { role: "user" as const, content: "c" },
        { role: "assistant" as const, content: "d" },
        { role: "user" as const, content: "e" },
      ],
      "sys",
    );

    expect(result).toEqual([
      { role: "user" as const, content: "question one" },
      { role: "assistant" as const, content: "answer one" },
      { role: "user" as const, content: "question two" },
    ]);
  });

  it("reduce skips empty entries when LLM omits content for a role", async () => {
    const modelAdapter = {
      completeSimple: vi.fn(async () => assistantTextMessage("[USER]: \n[ASSISTANT]: actual content")),
    } as any;

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      modelAdapter,
    });

    const result = await reducer.reduce(
      [
        { role: "user" as const, content: "a" },
        { role: "assistant" as const, content: "b" },
        { role: "user" as const, content: "c" },
      ],
      "sys",
    );

    expect(result).toEqual([{ role: "assistant" as const, content: "actual content" }]);
  });
});
