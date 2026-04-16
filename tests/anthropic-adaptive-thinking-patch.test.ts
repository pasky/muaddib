import { describe, expect, it } from "vitest";

import { getApiProvider, type Model, type Context } from "@mariozechner/pi-ai";

// Importing the adapter module triggers installAnthropicAdaptiveThinkingPatch() as a side effect.
import "../src/models/pi-ai-model-adapter.js";

/**
 * These tests rely on the patched streamSimple being invoked through pi-ai's
 * registered `anthropic-messages` provider. We don't actually hit the Anthropic
 * API; we feed in a stub `onPayload` whose return value short-circuits the
 * request (we never await the stream), and assert how the patch rewrote params.
 */

interface AnthropicLikeParams {
  model?: string;
  thinking?: { type: string; budget_tokens?: number };
  output_config?: { effort: string };
  max_tokens?: number;
}

function emptyAnthropicModel(id: string): Model<"anthropic-messages"> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

async function captureBuiltPayload(
  modelId: string,
  reasoning: "minimal" | "low" | "medium" | "high" | "xhigh",
): Promise<AnthropicLikeParams> {
  const provider = getApiProvider("anthropic-messages");
  if (!provider) throw new Error("anthropic-messages provider missing");

  const model = emptyAnthropicModel(modelId);
  const context: Context = { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] };

  return await new Promise<AnthropicLikeParams>((resolve, reject) => {
    class AbortSentinel extends Error { constructor() { super("abort"); this.name = "AbortSentinel"; } }
    const stream = provider.streamSimple(model, context, {
      apiKey: "sk-ant-fake",
      reasoning,
      onPayload: (payload: unknown) => {
        // Capture the payload the rewriter produced, then abort the request.
        resolve(payload as AnthropicLikeParams);
        throw new AbortSentinel();
      },
    });
    // Drain the stream; ignore the abort we injected above.
    (async () => {
      try {
        for await (const _ of stream) { /* consume */ }
      } catch (err) {
        if ((err as Error)?.name !== "AbortSentinel") reject(err);
      }
    })();
  });
}

describe("anthropic-adaptive-thinking-patch", () => {
  it("rewrites budget-based thinking to adaptive for opus-4-7", async () => {
    const payload = await captureBuiltPayload("claude-opus-4-7", "medium");
    expect(payload.thinking).toEqual({ type: "adaptive" });
    expect(payload.output_config).toEqual({ effort: "medium" });
  });

  it("maps xhigh to 'max' effort on opus models", async () => {
    const payload = await captureBuiltPayload("claude-opus-4-7", "xhigh");
    expect(payload.output_config).toEqual({ effort: "max" });
  });

  it("rewrites for sonnet 4.7+ as well", async () => {
    const payload = await captureBuiltPayload("claude-sonnet-4-7", "high");
    expect(payload.thinking).toEqual({ type: "adaptive" });
    expect(payload.output_config).toEqual({ effort: "high" });
  });

  it("clamps xhigh to 'high' on sonnet (no 'max' support)", async () => {
    const payload = await captureBuiltPayload("claude-sonnet-4-7", "xhigh");
    expect(payload.output_config).toEqual({ effort: "high" });
  });

  it("leaves pi-ai's native adaptive path alone for opus-4-6", async () => {
    // pi-ai already produces adaptive thinking for opus-4-6; our rewriter must
    // not double-rewrite (the `thinking.type === 'enabled'` guard prevents it).
    const payload = await captureBuiltPayload("claude-opus-4-6", "medium");
    expect(payload.thinking).toEqual({ type: "adaptive" });
    expect(payload.output_config).toEqual({ effort: "medium" });
  });

  it("does not rewrite older opus models that legitimately use budget-based thinking", async () => {
    const payload = await captureBuiltPayload("claude-opus-4-5", "medium");
    expect(payload.thinking?.type).toBe("enabled");
    expect(payload.output_config).toBeUndefined();
  });
});
