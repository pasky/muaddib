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
    vi.useFakeTimers();
    try {
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

    const promise = runner.prompt("hello");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.text).toBe("final answer");
    expect(result.iterations).toBe(2);
    expect(result.toolCallsCount).toBe(2);
    expect(result.usage.totalTokens).toBe(15);
    expect(result.stopReason).toBe("stop");
    expect(ensureProviderKey).toHaveBeenCalledWith("openai");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

  it("logs full assistant metadata and preserves long content text/thinking in message_end debug", async () => {
    const callbacks: Array<(event: any) => void> = [];
    const unsubscribe = vi.fn();
    const longText = "L".repeat(5000);
    const longThinking = "T".repeat(5000);
    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: longText, textSignature: "sig-text" },
        { type: "thinking", thinking: longThinking, thinkingSignature: "sig-thinking" },
        {
          type: "toolCall",
          id: "tool-1",
          name: "web_search",
          arguments: { query: "muaddib" },
          thoughtSignature: "sig-tool",
        },
      ],
      usage: makeUsage(3),
      stopReason: "length",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o-mini",
      errorMessage: "hit token limit",
      timestamp: 123,
      extraField: { nested: true },
    };

    const session = {
      messages: [] as any[],
      subscribe: vi.fn((callback: (event: any) => void) => {
        callbacks.push(callback);
        return unsubscribe;
      }),
      prompt: vi.fn(async () => {
        session.messages.push(assistantMessage);
        callbacks.forEach((cb) => cb({ type: "turn_end" }));
        callbacks.forEach((cb) => cb({ type: "message_end", message: assistantMessage }));
      }),
    };

    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent: { setModel: vi.fn() },
      ensureProviderKey: vi.fn(async () => {}),
      getVisionFallbackActivated: () => false,
    });

    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",
      authStorage: AuthStorage.inMemory(),
      logger,
      llmDebugMaxChars: 20_000,
      modelAdapter: {
        resolve: (spec: string) => ({
          spec: { provider: spec.split(":")[0], modelId: spec.split(":")[1] },
          model: { provider: spec.split(":")[0], id: spec.split(":")[1] },
        }),
      } as any,
    });

    await runner.prompt("hello");

    const responseLogCall = logger.debug.mock.calls.find(
      ([message]) => message === "llm_io response agent_stream",
    );
    expect(responseLogCall).toBeDefined();

    const payload = JSON.parse(String(responseLogCall?.[1])) as {
      api: string;
      usage: Usage;
      errorMessage: string;
      extraField: { nested: boolean };
      content: Array<{
        type: string;
        text?: string;
        textSignature?: string;
        thinking?: string;
        thinkingSignature?: string;
        thoughtSignature?: string;
      }>;
    };

    expect(payload.api).toBe("openai-responses");
    expect(payload.usage.totalTokens).toBe(15);
    expect(payload.usage.cost.total).toBe(3);
    expect(payload.errorMessage).toBe("hit token limit");
    expect(payload.extraField).toEqual({ nested: true });
    expect(payload.content[0].text).toBe(longText);
    expect(payload.content[0].textSignature).toBe("sig-text");
    expect(payload.content[1].thinking).toBe(longThinking);
    expect(payload.content[1].thinkingSignature).toBe("sig-thinking");
    expect(payload.content[2].thoughtSignature).toBe("sig-tool");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("throws when completion remains empty after retries", async () => {
    vi.useFakeTimers();
    try {
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
        authStorage: AuthStorage.inMemory(),
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        modelAdapter: { resolve: () => ({ spec: { provider: "openai", modelId: "gpt-4o-mini" }, model: {} }) } as any,
      });

      const promise = runner.prompt("hello");
      const assertion = expect(promise).rejects.toThrow("Agent produced empty completion after 3 retries.");
      await vi.runAllTimersAsync();
      await assertion;
      expect(session.prompt).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });


});
