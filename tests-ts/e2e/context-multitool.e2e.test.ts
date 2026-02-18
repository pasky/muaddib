/**
 * E2E test: Context reduction + multi-tool + progress reports + tool summary (Scenario #2)
 *
 * Exercises: 10 seeded history messages → context reduction via completeSimple →
 * agent calls web_search (fetch mock) → progress_report tool → final text response →
 * tool summary via completeSimple persisted as internal monologue.
 *
 * Mock boundaries:
 *   - `streamSimple` from `@mariozechner/pi-ai` (scripted LLM responses)
 *   - `completeSimple` from `@mariozechner/pi-ai` (context reducer + tool summary)
 *   - global `fetch` (for Jina web search API)
 */

import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageText } from "../../src/utils/index.js";

import {
  type E2EContext,
  type StreamMockState,
  buildIrcMonitor,
  buildRuntime,
  createE2EContext,
  createStreamMockState,
  handleStreamSimpleCall,
  makeAssistantMessage,
  resetStreamMock,
  textStream,
  toolCallStream,
  baseCommandConfig,
} from "./helpers.js";
import { resetWebRateLimiters } from "../../src/agent/tools/web.js";

// ── Mock streamSimple + completeSimple ──

const mockState: StreamMockState = createStreamMockState();
const completeSimpleCalls: Array<{ model: unknown; context: unknown; options: unknown }> = [];
let completeSimpleResponses: Array<() => ReturnType<typeof makeAssistantMessage>> = [];
let completeSimpleIndex = 0;

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    streamSimple: (...args: unknown[]) => handleStreamSimpleCall(mockState, ...args),
    completeSimple: async (...args: unknown[]) => {
      completeSimpleCalls.push({
        model: args[0],
        context: args[1],
        options: args[2],
      });
      const factory = completeSimpleResponses[completeSimpleIndex];
      if (!factory) {
        throw new Error(`No scripted completeSimple response for call index ${completeSimpleIndex}`);
      }
      completeSimpleIndex += 1;
      return factory();
    },
  };
});

// ── Test data ──

const FAKE_JINA_SEARCH_RESPONSE = `Title: TypeScript Handbook
URL: https://www.typescriptlang.org/docs/handbook/
Description: The TypeScript Handbook is a comprehensive guide to the TypeScript language.

Title: TypeScript - Wikipedia
URL: https://en.wikipedia.org/wiki/TypeScript
Description: TypeScript is a programming language developed by Microsoft.`;

const TOOL_SUMMARY_TEXT = "Used web_search to find TypeScript documentation. Found the TypeScript Handbook and Wikipedia article about TypeScript.";

// ── Config ──

function scenario2Config(): Record<string, unknown> {
  const cmd = baseCommandConfig();
  // Enable autoReduceContext on the serious mode
  (cmd.modes.serious as any).autoReduceContext = true;
  return {
    providers: {
      openai: { apiKey: "sk-fake-openai-key" },
      anthropic: { apiKey: "sk-fake-anthropic-key" },
    },
    contextReducer: {
      model: "openai:gpt-4o-mini",
      prompt: "Condense the conversation history into a brief summary.",
    },
    tools: {
      jina: { apiKey: "jina-fake-key" },
      summary: { model: "openai:gpt-4o-mini" },
    },
    rooms: {
      common: { command: cmd },
      irc: {
        command: { historySize: 40 },
        varlink: { socketPath: "/tmp/muaddib-e2e-fake.sock" },
      },
    },
  };
}

// ── Test suite ──

describe("E2E: Context reduction + multi-tool + progress + tool summary", () => {
  let ctx: E2EContext;
  let fetchCalls: Array<{ url: string }>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    ctx = await createE2EContext();
    resetStreamMock(mockState);
    completeSimpleCalls.length = 0;
    completeSimpleResponses = [];
    completeSimpleIndex = 0;
    resetWebRateLimiters();
    fetchCalls = [];

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.startsWith("https://s.jina.ai/")) {
        fetchCalls.push({ url });
        return new Response(FAKE_JINA_SEARCH_RESPONSE, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      return originalFetch(input, init as any);
    }) as typeof globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await ctx.history.close();
    await rm(ctx.tmpHome, { recursive: true, force: true });
  });

  it("reduces context, runs web_search + progress_report, generates tool summary", async () => {
    // ── Seed 10 history messages ──
    const arc = { serverTag: "libera", channelName: "#test", mynick: "muaddib" };
    for (let i = 0; i < 10; i++) {
      const isUser = i % 2 === 0;
      await ctx.history.addMessage({
        ...arc,
        nick: isUser ? "alice" : "muaddib",
        content: isUser
          ? `User message ${i / 2 + 1}: talking about topic ${i}`
          : `Bot response ${(i - 1) / 2 + 1}: replying about topic ${i}`,
      });
    }

    // ── Script completeSimple responses ──
    // Call 1: context reduction
    completeSimpleResponses.push(() =>
      makeAssistantMessage(
        "[USER]: Alice asked several questions about various topics.\n[ASSISTANT]: Bot provided answers to each topic.",
      ),
    );
    // Call 2: tool summary (persistence)
    completeSimpleResponses.push(() =>
      makeAssistantMessage(TOOL_SUMMARY_TEXT),
    );

    // ── Script streamSimple responses ──
    // Call 1: agent decides to web_search
    mockState.responses = [
      toolCallStream({
        type: "toolCall",
        id: "tc_ws_1",
        name: "web_search",
        arguments: { query: "TypeScript handbook" },
      }),
      // Call 2: agent sends a progress report
      toolCallStream({
        type: "toolCall",
        id: "tc_pr_1",
        name: "progress_report",
        arguments: { text: "Searching for TypeScript docs..." },
      }),
      // Call 3: final text response
      textStream("Here's what I found about TypeScript: it's a typed superset of JavaScript developed by Microsoft."),
    ];

    const runtime = buildRuntime(ctx, scenario2Config());
    const monitor = buildIrcMonitor(runtime, ctx.sender);

    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "alice",
      message: "muaddib: !s tell me about TypeScript",
    });

    // ── Verify context reduction happened ──
    expect(completeSimpleCalls.length).toBeGreaterThanOrEqual(1);
    // First completeSimple call should be context reduction
    const reducerCall = completeSimpleCalls[0];
    expect((reducerCall.model as any).provider).toBe("openai");

    // ── Verify Jina web search fetch was called ──
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("TypeScript");

    // ── Verify all 3 streamSimple calls happened ──
    expect(mockState.calls).toHaveLength(3);

    // ── Verify context was reduced (first streamSimple call should have reduced context) ──
    // The reduced context should contain the summary, not all 10 original messages
    const firstCallContext = mockState.calls[0].context as any;
    const contextMessages = firstCallContext?.messages ?? [];
    // With reduction, we should have fewer messages than the original 10
    // (reduced context + the triggering message)
    expect(contextMessages.length).toBeLessThan(10);

    // ── Verify progress report was delivered to the channel ──
    expect(ctx.sender.sent.length).toBeGreaterThanOrEqual(2);
    const progressMessage = ctx.sender.sent.find((s: any) =>
      s.message.includes("Searching for TypeScript docs"),
    );
    expect(progressMessage).toBeDefined();
    expect(progressMessage!.target).toBe("#test");

    // ── Verify FakeSender got the final response ──
    const mainResponse = ctx.sender.sent.find((s: any) =>
      s.message.includes("TypeScript") && !s.message.includes("Searching"),
    );
    expect(mainResponse).toBeDefined();
    expect(mainResponse!.target).toBe("#test");
    expect(mainResponse!.message).toContain("TypeScript");

    // ── Verify tool summary was generated and persisted ──
    expect(completeSimpleCalls.length).toBe(2);
    // The tool summary completeSimple call
    const summaryCall = completeSimpleCalls[1];
    expect((summaryCall.model as any).provider).toBe("openai");

    // Verify internal monologue was stored in history
    const historyMessages = await ctx.history.getContextForMessage(
      { ...arc, nick: "alice", content: "check" },
      50,
    );
    const monologueMessages = historyMessages.filter((m) => {
      const text = messageText(m);
      return text.includes("[internal monologue]") && text.includes(TOOL_SUMMARY_TEXT);
    });
    expect(monologueMessages).toHaveLength(1);
  }, 30_000);
});
