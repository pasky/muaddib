/**
 * E2E test: Steering mid-flight (Scenario #5)
 *
 * First IRC message triggers an agent run using web_search. While the
 * tool's fetch is in-flight, a second IRC message from the same user
 * arrives and is enqueued in the steering queue. At the next agent loop
 * turn boundary the steering message is injected, and the agent
 * incorporates it into the final response.
 *
 * Mock boundaries:
 *   - `streamSimple` from `@mariozechner/pi-ai` (scripted LLM responses)
 *   - global `fetch` (for Jina web search API — also triggers second message)
 */

import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type E2EContext,
  type StreamMockState,
  buildIrcMonitor,
  buildRuntime,
  createE2EContext,
  createStreamMockState,
  e2eConfig,
  handleStreamSimpleCall,
  resetStreamMock,
  textStream,
  toolCallStream,
} from "./helpers.js";
import { resetWebRateLimiters } from "../../src/agent/tools/web.js";
import type { IrcRoomMonitor } from "../../src/rooms/irc/monitor.js";

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

const FAKE_JINA_RESPONSE = `Title: Weather today
URL: https://weather.example.com
Description: It is sunny and 25°C today.`;

// ── Test suite ──

describe("E2E: Steering mid-flight", () => {
  let ctx: E2EContext;
  let monitor: IrcRoomMonitor;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    ctx = await createE2EContext();
    resetStreamMock(mockState);
    resetWebRateLimiters();

    const runtime = buildRuntime(ctx, e2eConfig());
    monitor = buildIrcMonitor(runtime, ctx.sender);

    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await ctx.history.close();
    await rm(ctx.tmpHome, { recursive: true, force: true });
  });

  it("second message steers the running agent mid-flight", async () => {
    // Script 3 sequential streamSimple calls:
    // 1. Agent → web_search tool call
    // 2. Agent → final text (after web_search result + steering message)
    //
    // During the fetch for web_search, we inject the second IRC message.
    // The steering provider drains it at the turn boundary (after tool completes).
    // The agent's second call sees the steering message in context.
    mockState.responses = [
      // 1. Agent decides to web_search
      toolCallStream({
        type: "toolCall",
        id: "tc_ws_1",
        name: "web_search",
        arguments: { query: "weather today" },
      }),
      // 2. Agent responds incorporating both the search result and steering
      textStream(
        "The weather is sunny and 25°C. And yes, alice, I can also recommend sunscreen!",
      ),
    ];

    // During the Jina fetch, inject a second IRC message from the same user.
    // We must ensure the second message is fully enqueued in the steering
    // queue *before* the fetch resolves (which completes the tool and
    // triggers the turn_end where steering is drained).
    //
    // Strategy: the fetch mock kicks off the second processMessageEvent,
    // then yields via setTimeout so the message handler's synchronous
    // enqueue runs before the fetch response is returned.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.startsWith("https://s.jina.ai/")) {
        // Start processing the second message (this enters the handler
        // synchronously up to the enqueue point, then awaits completion).
        const secondDone = monitor.processMessageEvent({
          type: "message",
          subtype: "public",
          server: "libera",
          target: "#test",
          nick: "alice",
          message: "muaddib: !s also recommend sunscreen please",
        });

        // Yield to let the second message's handler enqueue into the
        // steering queue before we return the fetch response.
        await new Promise((r) => setTimeout(r, 100));

        // The secondDone promise resolves once steering drains the item,
        // which happens after this fetch completes. We don't await it here.
        void secondDone;

        return new Response(FAKE_JINA_RESPONSE, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      return originalFetch(input, init as any);
    }) as typeof globalThis.fetch;

    // Send the first message that triggers the agent run.
    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "alice",
      message: "muaddib: !s what's the weather today?",
    });

    // ── Verify all 2 streamSimple calls happened ──
    expect(mockState.calls).toHaveLength(2);

    // ── Verify the second streamSimple call received the steering message ──
    // The context for call #2 should contain the steered user message.
    const secondCallContext = mockState.calls[1].context as any;
    const contextMessages = Array.isArray(secondCallContext)
      ? secondCallContext
      : secondCallContext?.messages ?? [];

    // Find a user message containing the steering content
    const steeringMsg = contextMessages.find(
      (m: any) =>
        m.role === "user" &&
        typeof m.content === "string"
          ? m.content.includes("sunscreen")
          : Array.isArray(m.content) &&
            m.content.some(
              (c: any) => c.type === "text" && c.text?.includes("sunscreen"),
            ),
    );
    expect(steeringMsg).toBeDefined();

    // ── Verify FakeSender got the final response ──
    expect(ctx.sender.sent.length).toBeGreaterThanOrEqual(1);
    const mainResponse = ctx.sender.sent[0];
    expect(mainResponse.target).toBe("#test");
    expect(mainResponse.server).toBe("libera");
    expect(mainResponse.message).toContain("sunscreen");
  }, 30_000);
});
