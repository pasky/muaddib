/**
 * E2E test: Oracle tool with nested web_search (Scenario #1)
 *
 * Exercises: IrcRoomMonitor → RoomMessageHandler → CommandExecutor
 * → SessionRunner → Agent loop → oracle tool → nested SessionRunner
 * → web_search tool → Jina fetch → oracle result → final IRC response.
 *
 * Mock boundaries:
 *   - `streamSimple` from `@mariozechner/pi-ai` (scripted LLM responses)
 *   - global `fetch` (for Jina web search API)
 */

import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type E2EContext,
  type StreamMockState,
  baseCommandConfig,
  buildIrcMonitor,
  buildRuntime,
  createE2EContext,
  createStreamMockState,
  handleStreamSimpleCall,
  resetStreamMock,
  textStream,
  toolCallStream,
} from "./helpers.js";
import { resetWebRateLimiters } from "../../src/agent/tools/web.js";

// ── Mock streamSimple ──

const mockState: StreamMockState = createStreamMockState();

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    streamSimple: (...args: unknown[]) => handleStreamSimpleCall(mockState, ...args),
    completeSimple: async () => {
      throw new Error("completeSimple should not be called in this test");
    },
  };
});

// ── Test data ──

const FAKE_JINA_SEARCH_RESPONSE = `Title: Dune novel - Wikipedia
URL: https://en.wikipedia.org/wiki/Dune_(novel)
Description: Dune is a 1965 epic science fiction novel by Frank Herbert.

Title: Dune Universe - Fandom
URL: https://dune.fandom.com/wiki/Dune
Description: The Dune universe is the setting of the Dune novels.`;

// ── Test suite ──

describe("E2E: Oracle with nested web_search", () => {
  let ctx: E2EContext;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    ctx = await createE2EContext();
    resetStreamMock(mockState);
    resetWebRateLimiters();
    fetchCalls = [];

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.startsWith("https://s.jina.ai/")) {
        fetchCalls.push({ url, init });
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

  it("oracle consults nested agent which uses web_search, then returns result to outer agent", async () => {
    // Script 4 sequential streamSimple calls:
    // 1. Outer agent → oracle tool call
    // 2. Inner oracle agent → web_search tool call
    // 3. Inner oracle agent → final text (after receiving search results)
    // 4. Outer agent → final IRC response (after receiving oracle result)
    mockState.responses = [
      // 1. Outer agent decides to consult the oracle
      toolCallStream({
        type: "toolCall",
        id: "tc_oracle_1",
        name: "oracle",
        arguments: { query: "What is the Dune novel about?" },
      }),
      // 2. Inner oracle agent decides to web_search
      toolCallStream({
        type: "toolCall",
        id: "tc_ws_1",
        name: "web_search",
        arguments: { query: "Dune novel Frank Herbert" },
      }),
      // 3. Inner oracle agent produces final answer
      textStream("Dune is a 1965 epic science fiction novel by Frank Herbert, set on the desert planet Arrakis."),
      // 4. Outer agent produces final IRC response
      textStream("According to the oracle: Dune is a 1965 sci-fi novel by Frank Herbert about the desert planet Arrakis."),
    ];

    const runtime = buildRuntime(ctx, {
      providers: {
        openai: { apiKey: "sk-fake-openai-key" },
        anthropic: { apiKey: "sk-fake-anthropic-key" },
      },
      tools: {
        oracle: {
          model: "anthropic:claude-sonnet-4-20250514",
          prompt: "You are a knowledgeable oracle. Answer queries thoroughly.",
        },
        jina: {
          apiKey: "jina-fake-key",
        },
      },
      rooms: {
        common: { command: baseCommandConfig() },
        irc: {
          command: { historySize: 40 },
          varlink: { socketPath: "/tmp/muaddib-e2e-fake.sock" },
        },
      },
    }, {
      openai: "sk-fake-openai-key",
      anthropic: "sk-fake-anthropic-key",
    });

    const monitor = buildIrcMonitor(runtime, ctx.sender);

    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "alice",
      message: "muaddib: !s tell me about the Dune novel",
    });

    // ── Verify Jina web search fetch was called ──
    expect(fetchCalls).toHaveLength(1);
    const jinaCall = fetchCalls[0];
    expect(jinaCall.url).toContain("https://s.jina.ai/?q=");
    expect(jinaCall.url).toContain(encodeURIComponent("Dune novel Frank Herbert"));
    expect(jinaCall.init?.headers).toMatchObject({
      Authorization: "Bearer jina-fake-key",
      "X-Respond-With": "no-content",
    });

    // ── Verify all 4 streamSimple calls happened ──
    expect(mockState.calls).toHaveLength(4);

    const modelProvider = (i: number) => (mockState.calls[i].model as any).provider;

    // Call 0: outer agent (openai:gpt-4o-mini)
    expect(modelProvider(0)).toBe("openai");
    // Call 1: inner oracle agent (anthropic:claude-sonnet-4-20250514)
    expect(modelProvider(1)).toBe("anthropic");
    // Call 2: inner oracle agent again (after web_search result)
    expect(modelProvider(2)).toBe("anthropic");
    // Call 3: outer agent again (after oracle result)
    expect(modelProvider(3)).toBe("openai");

    // ── Verify FakeSender got the final response ──
    expect(ctx.sender.sent.length).toBeGreaterThanOrEqual(1);
    const mainResponse = ctx.sender.sent[0];
    expect(mainResponse.target).toBe("#test");
    expect(mainResponse.server).toBe("libera");
    expect(mainResponse.message).toContain("Dune");
    expect(mainResponse.message).toContain("Frank Herbert");
  }, 30_000);
});
