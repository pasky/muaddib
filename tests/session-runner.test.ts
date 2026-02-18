import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Usage } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

import type { Mock } from "vitest";

let mockCreateAgentSessionForInvocation: Mock<(...args: unknown[]) => unknown>;

vi.mock("../src/agent/session-factory.js", () => ({
  createAgentSessionForInvocation: (...args: unknown[]) => mockCreateAgentSessionForInvocation(...args),
}));

import { SessionRunner } from "../src/agent/session-runner.js";

function makeUsage(multiplier = 1): Usage {
  return {
    input: 1 * multiplier,
    output: 2 * multiplier,
    cacheRead: 3 * multiplier,
    cacheWrite: 4 * multiplier,
    totalTokens: 5 * multiplier,
    cost: {
      input: 0.1 * multiplier,
      output: 0.2 * multiplier,
      cacheRead: 0.3 * multiplier,
      cacheWrite: 0.4 * multiplier,
      total: 1 * multiplier,
    },
  };
}

describe("SessionRunner", () => {
  beforeEach(() => {
    mockCreateAgentSessionForInvocation = vi.fn();
  });

  it("retries empty completions and aggregates usage/tool+turn counters", async () => {
    const callbacks: Array<(event: any) => void> = [];
    const unsubscribe = vi.fn();
    const session = {
      messages: [] as any[],
      subscribe: vi.fn((callback: (event: any) => void) => {
        callbacks.push(callback);
        return unsubscribe;
      }),
      prompt: vi.fn(async (promptText: string) => {
        callbacks.forEach((cb) => cb({ type: "turn_end" }));
        callbacks.forEach((cb) => cb({ type: "tool_execution_start", toolName: "execute_code", args: { x: 1 } }));
        callbacks.forEach((cb) => cb({
          type: "tool_execution_end",
          toolName: "execute_code",
          isError: false,
          result: [{ type: "text", text: "ok" }],
        }));

        if (promptText.includes("No valid text")) {
          session.messages.push({
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
            usage: makeUsage(2),
            stopReason: "stop",
          });
          callbacks.forEach((cb) => cb({ type: "message_end", message: session.messages.at(-1) }));
          return;
        }

        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "   " }],
          usage: makeUsage(1),
          stopReason: "max_tokens",
        });
        callbacks.forEach((cb) => cb({ type: "message_end", message: session.messages.at(-1) }));
      }),
    };

    const agent = { setModel: vi.fn() };
    const ensureProviderKey = vi.fn(async () => {});

    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent,
      ensureProviderKey,
      getVisionFallbackActivated: () => false,
    });

    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",
      authStorage: AuthStorage.inMemory(),
      logger,
      modelAdapter: {
        resolve: (spec: string) => ({
          spec: { provider: spec.split(":")[0], modelId: spec.split(":")[1] },
          model: { provider: spec.split(":")[0], id: spec.split(":")[1] },
        }),
      } as any,
    });

    const result = await runner.prompt("hello");

    expect(result.text).toBe("final answer");
    expect(result.iterations).toBe(2);
    expect(result.toolCallsCount).toBe(2);
    expect(result.usage.totalTokens).toBe(15);
    expect(result.stopReason).toBe("stop");
    expect(ensureProviderKey).toHaveBeenCalledWith("openai");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("switches to refusal fallback model when refusal error is detected", async () => {
    const session = {
      messages: [] as any[],
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi
        .fn()
        .mockRejectedValueOnce(new Error("invalid_prompt for safety reasons"))
        .mockResolvedValue(undefined),
    };
    const agent = { setModel: vi.fn() };
    const ensureProviderKey = vi.fn(async () => {});

    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent,
      ensureProviderKey,
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",

      authStorage: AuthStorage.inMemory(),      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      modelAdapter: {
        resolve: (spec: string) => ({
          spec: { provider: spec.split(":")[0], modelId: spec.split(":")[1] },
          model: { provider: spec.split(":")[0], id: spec.split(":")[1] },
        }),
      } as any,
    });

    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: makeUsage(),
      stopReason: "stop",
    });

    const result = await runner.prompt("hello", { refusalFallbackModel: "anthropic:claude-sonnet-4" });

    expect(result.refusalFallbackActivated).toBe(true);
    expect(result.refusalFallbackModel).toBe("anthropic:claude-sonnet-4");
    expect(ensureProviderKey).toHaveBeenCalledWith("anthropic");
    expect(agent.setModel).toHaveBeenCalledWith({ provider: "anthropic", id: "claude-sonnet-4" });
  });

  it("throws when completion remains empty after retries", async () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "   " }],
          usage: makeUsage(),
          stopReason: "stop",
        },
      ] as any[],
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => {}),
    };

    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent: { setModel: vi.fn() },
      ensureProviderKey: vi.fn(async () => {}),
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",

      authStorage: AuthStorage.inMemory(),      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      modelAdapter: { resolve: () => ({ spec: { provider: "openai", modelId: "gpt-4o-mini" }, model: {} }) } as any,
    });

    await expect(runner.prompt("hello")).rejects.toThrow("Agent produced empty completion after 3 retries.");
    expect(session.prompt).toHaveBeenCalledTimes(4);
  });

  it("throws immediately on stopReason error without retrying", async () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [],
          usage: makeUsage(),
          stopReason: "error",
          errorMessage: "upstream failure",
          provider: "openrouter",
          model: "google/gemini-3-flash",
        },
      ] as any[],
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => {}),
    };

    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent: { setModel: vi.fn() },
      ensureProviderKey: vi.fn(async () => {}),
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",
      authStorage: AuthStorage.inMemory(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      modelAdapter: { resolve: () => ({ spec: { provider: "openai", modelId: "gpt-4o-mini" }, model: {} }) } as any,
    });

    await expect(runner.prompt("hello")).rejects.toThrow("Model returned error stop reason after prompt");
    await expect(runner.prompt("hello")).rejects.toThrow("upstream failure");
    // No retry attempts — only the initial prompt call
    expect(session.prompt).toHaveBeenCalledTimes(2); // two calls from two expect lines
  });
});
