/**
 * E2E test: Image generation pipeline (Scenario #4)
 *
 * Exercises the full pipeline: IrcRoomMonitor → RoomMessageHandler → CommandExecutor
 * → SessionRunner → Agent loop → generate_image tool → OpenRouter fetch → artifact storage.
 *
 * Mock boundaries:
 *   - `streamSimple` from `@mariozechner/pi-ai` (scripted LLM responses)
 *   - global `fetch` (for OpenRouter image generation API)
 *
 * Verification:
 *   - Fetch called with correct OpenRouter URL, headers, body
 *   - Artifact file written to disk
 *   - FakeSender.sent contains artifact URL
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type E2EContext,
  type StreamMockState,
  baseE2EConfig,
  buildIrcMonitor,
  buildRuntime,
  createE2EContext,
  createStreamMockState,
  handleStreamSimpleCall,
  resetStreamMock,
  textStream,
  toolCallStream,
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

// ── Test data ──

// 1x1 red pixel PNG as base64
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

const FAKE_OPENROUTER_RESPONSE = {
  choices: [
    {
      message: {
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${TINY_PNG_BASE64}`,
            },
          },
        ],
      },
    },
  ],
};

// ── Test suite ──

describe("E2E: Image generation pipeline", () => {
  let ctx: E2EContext;
  let fetchCalls: Array<{ url: string; init: RequestInit }>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    ctx = await createE2EContext();
    resetStreamMock(mockState);
    fetchCalls = [];

    // Mock global fetch for OpenRouter calls
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("openrouter.ai")) {
        fetchCalls.push({ url, init: init! });
        return new Response(JSON.stringify(FAKE_OPENROUTER_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Pass through anything else
      return originalFetch(input, init as any);
    }) as typeof globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await ctx.history.close();
    await rm(ctx.tmpHome, { recursive: true, force: true });
  });

  it("generates image via OpenRouter, writes artifact, and returns URL in IRC", async () => {
    const artifactsPath = join(ctx.tmpHome, "artifacts");
    const artifactsUrl = "https://example.com/artifacts";

    // Script LLM responses:
    // 1. Tool call: generate_image
    // 2. Final text response with artifact URL placeholder (agent sees actual URL from tool result)
    mockState.responses = [
      toolCallStream({
        type: "toolCall",
        id: "tc_img_1",
        name: "generate_image",
        arguments: { prompt: "a red pixel" },
      }),
      textStream(`Here is your image: ${artifactsUrl}/?generated.png`),
    ];

    const runtime = buildRuntime(ctx, baseE2EConfig({
      providers: {
        openrouter: { apiKey: "sk-fake-openrouter-key" },
      },
      tools: {
        artifacts: {
          path: artifactsPath,
          url: artifactsUrl,
        },
        imageGen: {
          model: "openrouter:some-image-model",
        },
      },
    }));

    const monitor = buildIrcMonitor(runtime, ctx.sender);

    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "alice",
      message: "muaddib: !s generate a red pixel image",
    });

    // ── Verify fetch was called correctly ──
    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toMatchObject({
      Authorization: "Bearer sk-fake-openrouter-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(call.init.body as string);
    expect(body.model).toBe("some-image-model");
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: "a red pixel" });
    expect(body.modalities).toEqual(["image", "text"]);

    // ── Verify artifact file was written to disk ──
    const files = await readdir(artifactsPath);
    const pngFiles = files.filter((f) => f.endsWith(".png"));
    expect(pngFiles.length).toBeGreaterThanOrEqual(1);

    // ── Verify FakeSender got response containing artifact URL ──
    expect(ctx.sender.sent.length).toBeGreaterThanOrEqual(1);
    const mainResponse = ctx.sender.sent[0];
    expect(mainResponse.target).toBe("#test");
    expect(mainResponse.server).toBe("libera");
    expect(mainResponse.message).toContain(artifactsUrl);

    // ── Verify streamSimple was called twice (tool call + final response) ──
    expect(mockState.calls).toHaveLength(2);
  }, 30_000);
});
