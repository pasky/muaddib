import { describe, expect, it, vi } from "vitest";
import type { Message } from "@mariozechner/pi-ai";

import { ContextReducerTs } from "../src/rooms/command/context-reducer.js";
import { createStubAssistantFields } from "../src/history/chat-history-store.js";

function userMsg(content: string): Message {
  return { role: "user", content, timestamp: 0 };
}

function assistantMsg(content: string): Message {
  return { role: "assistant", content: [{ type: "text", text: content }], ...createStubAssistantFields(), timestamp: 0 };
}

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
  const modelAdapter = { completeSimple: vi.fn() } as any;

  it("isConfigured returns false when model or prompt is missing", () => {
    expect(new ContextReducerTs({ modelAdapter }).isConfigured).toBe(false);
    expect(new ContextReducerTs({ config: { model: "openai:gpt-4o-mini" }, modelAdapter }).isConfigured).toBe(false);
    expect(new ContextReducerTs({ config: { prompt: "Reduce this" }, modelAdapter }).isConfigured).toBe(false);
  });

  it("isConfigured returns true when both model and prompt are set", () => {
    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce this" },
      modelAdapter,
    });
    expect(reducer.isConfigured).toBe(true);
  });

  it("reduce returns context minus last message when not configured", async () => {
    const reducer = new ContextReducerTs({ modelAdapter });
    const context = [
      userMsg("hello"),
      assistantMsg("hi"),
      userMsg("latest"),
    ];

    const result = await reducer.reduce(context, "system prompt");
    expect(result).toEqual([
      userMsg("hello"),
      assistantMsg("hi"),
    ]);
  });

  it("reduce returns empty array when context has no messages to reduce", async () => {
    const modelAdapter = { completeSimple: vi.fn() } as any;
    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      modelAdapter,
    });

    const result = await reducer.reduce([userMsg("only message")], "sys");
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
      userMsg("long question"),
      assistantMsg("long answer"),
      userMsg("follow up"),
    ];

    const result = await reducer.reduce(context, "agent system prompt");
    expect(result).toEqual([
      userMsg("summarized question"),
      assistantMsg("summarized answer"),
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
      userMsg("tell me about cats"),
      assistantMsg("cats are great"),
      userMsg("more"),
    ];

    const result = await reducer.reduce(context, "sys");
    expect(result).toEqual([
      userMsg("<context_summary>The user asked about cats and the assistant explained feline behavior.</context_summary>"),
    ]);
  });

  it("reduce falls back to sliced context when LLM returns empty response", async () => {
    const modelAdapter = { completeSimple: vi.fn(async () => assistantTextMessage("")) } as any;

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      modelAdapter,
    });

    const context = [
      userMsg("a"),
      assistantMsg("b"),
      userMsg("c"),
    ];

    const result = await reducer.reduce(context, "sys");
    expect(result).toEqual([
      userMsg("a"),
      assistantMsg("b"),
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
      userMsg("a"),
      userMsg("b"),
    ];

    const result = await reducer.reduce(context, "sys");
    expect(result).toEqual([userMsg("a")]);
  });

  it("reduce does not pass API key callback per-call when adapter is injected", async () => {
    const modelAdapter = { completeSimple: vi.fn(async () => assistantTextMessage("[USER]: hi")) } as any;

    const reducer = new ContextReducerTs({
      config: { model: "openai:gpt-4o-mini", prompt: "Reduce" },
      modelAdapter,
    });

    await reducer.reduce(
      [
        userMsg("a"),
        userMsg("b"),
      ],
      "sys",
    );

    const firstCall = modelAdapter.completeSimple.mock.calls[0] as any[];
    expect(firstCall[2]).not.toHaveProperty("authStorage");
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
        userMsg("a"),
        assistantMsg("b"),
        userMsg("c"),
        assistantMsg("d"),
        userMsg("e"),
      ],
      "sys",
    );

    expect(result).toEqual([
      userMsg("question one"),
      assistantMsg("answer one"),
      userMsg("question two"),
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
        userMsg("a"),
        assistantMsg("b"),
        userMsg("c"),
      ],
      "sys",
    );

    expect(result).toEqual([assistantMsg("actual content")]);
  });
});
