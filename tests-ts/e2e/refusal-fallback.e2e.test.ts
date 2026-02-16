/**
 * E2E test: Refusal → fallback → annotated response (Scenario #3)
 *
 * Exercises the full pipeline from IrcRoomMonitor.processMessageEvent through
 * the real RoomMessageHandler, CommandExecutor, SessionRunner, and Agent loop.
 *
 * Mock boundaries:
 *   - `streamSimple` from `@mariozechner/pi-ai` (scripted LLM responses)
 *   - `getApiKey` on runtime (returns fake keys)
 *
 * Verification:
 *   - FakeSender.sent contains the response with `[refusal fallback to ...]`
 *   - ChatHistoryStore has the persisted messages
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
} from "./helpers.js";

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

// ── Test suite ──

describe("E2E: Refusal → fallback → annotated response", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await createE2EContext();
    resetStreamMock(mockState);
  });

  afterEach(async () => {
    await ctx.history.close();
    await rm(ctx.tmpHome, { recursive: true, force: true });
  });

  it("detects refusal, switches to fallback model, and annotates response", async () => {
    // Script LLM responses:
    // 1. Primary model returns refusal text
    // 2. Fallback model returns actual answer
    mockState.responses = [
      textStream('{"is_refusal": true, "reason": "content policy"}'),
      textStream("The answer to your question is 42."),
    ];

    const runtime = buildRuntime(ctx, {
      providers: {
        openai: { apiKey: "sk-fake-openai-key" },
        anthropic: { apiKey: "sk-fake-anthropic-key" },
      },
      router: {
        refusalFallbackModel: "anthropic:claude-3-5-sonnet-20241022",
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
      message: "muaddib: !s What is the meaning of life?",
    });

    // Verify streamSimple was called twice (primary + fallback)
    expect(mockState.calls).toHaveLength(2);

    // Verify FakeSender got the response with refusal fallback annotation
    expect(ctx.sender.sent.length).toBeGreaterThanOrEqual(1);
    const mainResponse = ctx.sender.sent[0];
    expect(mainResponse.target).toBe("#test");
    expect(mainResponse.server).toBe("libera");
    expect(mainResponse.message).toContain("The answer to your question is 42.");
    expect(mainResponse.message).toContain("[refusal fallback to");
    expect(mainResponse.message).toContain("claude-3-5-sonnet-20241022");

    // Verify history has the persisted messages
    const historyRows = await ctx.history.getFullHistory("libera", "#test");
    expect(historyRows.length).toBeGreaterThanOrEqual(2); // user message + bot response
    const botMessage = historyRows.find((row) => row.nick === "muaddib");
    expect(botMessage).toBeDefined();
    expect(botMessage!.message).toContain("The answer to your question is 42.");
    expect(botMessage!.message).toContain("[refusal fallback to");
  }, 30_000);
});
