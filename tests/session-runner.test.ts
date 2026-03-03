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
        callbacks.forEach((cb) => cb({ type: "tool_execution_start", toolName: "bash", args: { x: 1 } }));
        callbacks.forEach((cb) => cb({
          type: "tool_execution_end",
          toolName: "bash",
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
      responseTimestamp: { lastResponseAt: 0 },
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
    // peakTurnInput = max(input + cacheRead + cacheWrite) across turns = makeUsage(2) → 2+6+8 = 16
    expect(result.peakTurnInput).toBe(16);
    expect(result.stopReason).toBe("stop");
    expect(ensureProviderKey).toHaveBeenCalledWith("openai");
    // unsubscribe is deferred to session.dispose() on the success path
    expect(unsubscribe).not.toHaveBeenCalled();
    await result.session!.dispose();
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
      responseTimestamp: { lastResponseAt: 0 },
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

  it("defers toolSet.dispose to session.dispose on success", async () => {
    const dispose = vi.fn(async () => {});
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "response" }],
          usage: makeUsage(),
          stopReason: "stop",
        },
      ] as any[],
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent: { setModel: vi.fn() },
      ensureProviderKey: vi.fn(async () => {}),
      responseTimestamp: { lastResponseAt: 0 },
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",
      authStorage: AuthStorage.inMemory(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      modelAdapter: { resolve: () => ({ spec: { provider: "openai", modelId: "gpt-4o-mini" }, model: {} }) } as any,
      toolSet: { tools: [], dispose },
    });

    const result = await runner.prompt("hello");
    // toolSet.dispose is NOT called yet — deferred to session.dispose()
    expect(dispose).not.toHaveBeenCalled();

    // Calling session.dispose() triggers toolSet.dispose + original dispose
    await result.session!.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("does not double-dispose toolSet when session.dispose is called", async () => {
    const dispose = vi.fn(async () => {});
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "response" }],
          usage: makeUsage(),
          stopReason: "stop",
        },
      ] as any[],
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent: { setModel: vi.fn() },
      ensureProviderKey: vi.fn(async () => {}),
      responseTimestamp: { lastResponseAt: 0 },
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",
      authStorage: AuthStorage.inMemory(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      modelAdapter: { resolve: () => ({ spec: { provider: "openai", modelId: "gpt-4o-mini" }, model: {} }) } as any,
      toolSet: { tools: [], dispose },
    });

    const result = await runner.prompt("hello");
    await result.session!.dispose();
    await result.session!.dispose(); // second call should be safe
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("calls toolSet.dispose in finally block when prompt throws", async () => {
    const dispose = vi.fn(async () => {});
    const session = {
      messages: [] as any[],
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => { throw new Error("network failure"); }),
    };

    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent: { setModel: vi.fn() },
      ensureProviderKey: vi.fn(async () => {}),
      responseTimestamp: { lastResponseAt: 0 },
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",
      authStorage: AuthStorage.inMemory(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      modelAdapter: { resolve: () => ({ spec: { provider: "openai", modelId: "gpt-4o-mini" }, model: {} }) } as any,
      toolSet: { tools: [], dispose },
    });

    await expect(runner.prompt("hello")).rejects.toThrow("network failure");
    expect(dispose).toHaveBeenCalledTimes(1);
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
      responseTimestamp: { lastResponseAt: 0 },
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
    // unsubscribe is deferred to session.dispose() on the success path
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  function makeMinimalSession(text = "ok"): any {
    const callbacks: Array<(event: any) => void> = [];
    const session = {
      messages: [{ role: "assistant", content: [{ type: "text", text }], usage: makeUsage(), stopReason: "stop" }] as any[],
      subscribe: vi.fn((cb: (event: any) => void) => { callbacks.push(cb); return vi.fn(); }),
      prompt: vi.fn(async () => { callbacks.forEach((cb) => cb({ type: "turn_end" })); callbacks.forEach((cb) => cb({ type: "message_end", message: session.messages[0] })); }),
    };
    return session;
  }

  const minimalModelAdapter = { resolve: () => ({ spec: { provider: "openai", modelId: "gpt-4o-mini" }, model: {} }) } as any;
  const minimalLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  it("appends toolSet.systemPromptSuffix to system prompt passed to LLM", async () => {
    mockCreateAgentSessionForInvocation.mockReturnValue({
      session: makeMinimalSession(),
      agent: { setModel: vi.fn() },
      ensureProviderKey: vi.fn(async () => {}),
      responseTimestamp: { lastResponseAt: 0 },
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "base prompt",
      authStorage: AuthStorage.inMemory(),
      logger: minimalLogger,
      modelAdapter: minimalModelAdapter,
      toolSet: { tools: [], systemPromptSuffix: "Filesystem: /workspace persists; /tmp/session-abc is your session working directory." },
    });

    await runner.prompt("hello");

    const calledWith = mockCreateAgentSessionForInvocation.mock.calls[0]![0] as { systemPrompt: string };
    expect(calledWith.systemPrompt).toBe("base prompt\n\nFilesystem: /workspace persists; /tmp/session-abc is your session working directory.");
  });

  it("passes system prompt unchanged when toolSet has no systemPromptSuffix", async () => {
    mockCreateAgentSessionForInvocation.mockReturnValue({
      session: makeMinimalSession(),
      agent: { setModel: vi.fn() },
      ensureProviderKey: vi.fn(async () => {}),
      responseTimestamp: { lastResponseAt: 0 },
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "base prompt",
      authStorage: AuthStorage.inMemory(),
      logger: minimalLogger,
      modelAdapter: minimalModelAdapter,
      toolSet: { tools: [] },
    });

    await runner.prompt("hello");

    const calledWith = mockCreateAgentSessionForInvocation.mock.calls[0]![0] as { systemPrompt: string };
    expect(calledWith.systemPrompt).toBe("base prompt");
  });

  it("fires onResponse for every non-empty assistant text including the final one", async () => {
    const callbacks: Array<(event: any) => void> = [];
    const deliveredTexts: string[] = [];

    const session = {
      messages: [] as any[],
      subscribe: vi.fn((cb: (event: any) => void) => { callbacks.push(cb); return vi.fn(); }),
      prompt: vi.fn(async () => {
        // Turn 1: intermediate text + tool call
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Let me search for that." }],
          usage: makeUsage(),
          stopReason: "tool_use",
        });
        callbacks.forEach((cb) => cb({ type: "message_end", message: session.messages.at(-1) }));
        callbacks.forEach((cb) => cb({ type: "tool_execution_start", toolName: "web_search", args: {} }));
        callbacks.forEach((cb) => cb({ type: "tool_execution_end", toolName: "web_search", isError: false, result: "ok" }));
        callbacks.forEach((cb) => cb({ type: "turn_end" }));

        // Turn 2: final response
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Here is the final answer." }],
          usage: makeUsage(),
          stopReason: "stop",
        });
        callbacks.forEach((cb) => cb({ type: "message_end", message: session.messages.at(-1) }));
        callbacks.forEach((cb) => cb({ type: "turn_end" }));
      }),
    };

    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent: { setModel: vi.fn() },
      ensureProviderKey: vi.fn(async () => {}),
      responseTimestamp: { lastResponseAt: 0 },
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",
      authStorage: AuthStorage.inMemory(),
      logger: minimalLogger,
      modelAdapter: minimalModelAdapter,
      onResponse: (text: string) => { deliveredTexts.push(text); },
    });

    const result = await runner.prompt("hello");

    // All non-empty texts fire — including the final response
    expect(deliveredTexts).toEqual([
      "Let me search for that.",
      "Here is the final answer.",
    ]);
    expect(result.text).toBe("Here is the final answer.");
  });

  it("delivers final assistant text even if message_end is missing", async () => {
    const callbacks: Array<(event: any) => void> = [];
    const deliveredTexts: string[] = [];

    const session = {
      messages: [] as any[],
      subscribe: vi.fn((cb: (event: any) => void) => { callbacks.push(cb); return vi.fn(); }),
      prompt: vi.fn(async () => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Final without message_end." }],
          usage: makeUsage(),
          stopReason: "stop",
        });
        callbacks.forEach((cb) => cb({ type: "turn_end" }));
      }),
    };

    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent: { setModel: vi.fn() },
      ensureProviderKey: vi.fn(async () => {}),
      responseTimestamp: { lastResponseAt: 0 },
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",
      authStorage: AuthStorage.inMemory(),
      logger: minimalLogger,
      modelAdapter: minimalModelAdapter,
      onResponse: (text: string) => { deliveredTexts.push(text); },
    });

    const result = await runner.prompt("hello");

    expect(result.text).toBe("Final without message_end.");
    expect(deliveredTexts).toEqual(["Final without message_end."]);
  });

  it("awaits async onResponse delivery before prompt resolves", async () => {
    vi.useFakeTimers();
    try {
      const callbacks: Array<(event: any) => void> = [];
      const deliveredTexts: string[] = [];

      const session = {
        messages: [] as any[],
        subscribe: vi.fn((cb: (event: any) => void) => { callbacks.push(cb); return vi.fn(); }),
        prompt: vi.fn(async () => {
          session.messages.push({
            role: "assistant",
            content: [{ type: "text", text: "Delayed response." }],
            usage: makeUsage(),
            stopReason: "stop",
          });
          callbacks.forEach((cb) => cb({ type: "message_end", message: session.messages.at(-1) }));
          callbacks.forEach((cb) => cb({ type: "turn_end" }));
        }),
      };

      mockCreateAgentSessionForInvocation.mockReturnValue({
        session,
        agent: { setModel: vi.fn() },
        ensureProviderKey: vi.fn(async () => {}),
        responseTimestamp: { lastResponseAt: 0 },
        getVisionFallbackActivated: () => false,
      });

      const runner = new SessionRunner({
        model: "openai:gpt-4o-mini",
        systemPrompt: "sys",
        authStorage: AuthStorage.inMemory(),
        logger: minimalLogger,
        modelAdapter: minimalModelAdapter,
        onResponse: async (text: string) => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          deliveredTexts.push(text);
        },
      });

      const promptPromise = runner.prompt("hello");
      await vi.runAllTicks();

      let settled = false;
      void promptPromise.then(() => {
        settled = true;
      });

      await vi.runAllTicks();
      expect(settled).toBe(false);
      expect(deliveredTexts).toEqual([]);

      await vi.advanceTimersByTimeAsync(25);
      const result = await promptPromise;

      expect(result.text).toBe("Delayed response.");
      expect(deliveredTexts).toEqual(["Delayed response."]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire onResponse for whitespace-only assistant texts", async () => {
    const callbacks: Array<(event: any) => void> = [];
    const deliveredTexts: string[] = [];

    const session = {
      messages: [] as any[],
      subscribe: vi.fn((cb: (event: any) => void) => { callbacks.push(cb); return vi.fn(); }),
      prompt: vi.fn(async () => {
        // Turn 1: whitespace-only text + tool call
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "   " }],
          usage: makeUsage(),
          stopReason: "tool_use",
        });
        callbacks.forEach((cb) => cb({ type: "message_end", message: session.messages.at(-1) }));
        callbacks.forEach((cb) => cb({ type: "tool_execution_start", toolName: "bash", args: {} }));
        callbacks.forEach((cb) => cb({ type: "tool_execution_end", toolName: "bash", isError: false, result: "ok" }));
        callbacks.forEach((cb) => cb({ type: "turn_end" }));

        // Turn 2: final response
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          usage: makeUsage(),
          stopReason: "stop",
        });
        callbacks.forEach((cb) => cb({ type: "message_end", message: session.messages.at(-1) }));
        callbacks.forEach((cb) => cb({ type: "turn_end" }));
      }),
    };

    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent: { setModel: vi.fn() },
      ensureProviderKey: vi.fn(async () => {}),
      responseTimestamp: { lastResponseAt: 0 },
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",
      authStorage: AuthStorage.inMemory(),
      logger: minimalLogger,
      modelAdapter: minimalModelAdapter,
      onResponse: (text: string) => { deliveredTexts.push(text); },
    });

    const result = await runner.prompt("hello");
    // Only the non-whitespace text fires
    expect(deliveredTexts).toEqual(["Done."]);
    expect(result.text).toBe("Done.");
  });

  it("does not fire onResponse for session reuse (e.g. memory update) after main prompt returns", async () => {
    const callbacks: Array<(event: any) => void> = [];
    const deliveredTexts: string[] = [];
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const session = {
      messages: [] as any[],
      subscribe: vi.fn((cb: (event: any) => void) => { callbacks.push(cb); return vi.fn(); }),
      prompt: vi.fn(async () => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Main response." }],
          usage: makeUsage(),
          stopReason: "stop",
        });
        callbacks.forEach((cb) => cb({ type: "message_end", message: session.messages.at(-1) }));
        callbacks.forEach((cb) => cb({ type: "turn_end" }));
      }),
    };

    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent: { setModel: vi.fn() },
      ensureProviderKey: vi.fn(async () => {}),
      responseTimestamp: { lastResponseAt: 0 },
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",
      authStorage: AuthStorage.inMemory(),
      logger,
      modelAdapter: minimalModelAdapter,
      onResponse: (text: string) => { deliveredTexts.push(text); },
    });

    const result = await runner.prompt("hello");
    expect(deliveredTexts).toEqual(["Main response."]);
    expect(result.session).toBeDefined();
    expect(result.muteResponses).toBeTypeOf("function");

    // Caller mutes before background work (memory update)
    result.muteResponses!();

    // Simulate memory update: reuse the returned session for a follow-up prompt
    session.prompt.mockImplementation(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Memory updated." }],
        usage: makeUsage(),
        stopReason: "stop",
      });
      callbacks.forEach((cb) => cb({ type: "message_end", message: session.messages.at(-1) }));
      callbacks.forEach((cb) => cb({ type: "turn_end" }));
    });

    await result.session!.prompt("update memory");

    // onResponse must NOT have been called for the follow-up text
    expect(deliveredTexts).toEqual(["Main response."]);
    // Suppressed text should be logged at info level
    const infoArgs = logger.info.mock.calls.map((c: any[]) => c[0]);
    expect(infoArgs).toContain("Suppressing post-response text");
  });

  it("appends refusal fallback suffix to messages after fallback activates", async () => {
    const callbacks: Array<(event: any) => void> = [];
    const deliveredTexts: string[] = [];
    let promptCount = 0;

    const session = {
      messages: [] as any[],
      subscribe: vi.fn((cb: (event: any) => void) => { callbacks.push(cb); return vi.fn(); }),
      prompt: vi.fn(async () => {
        promptCount += 1;
        // First prompt: refusal text (detected by refusal signal)
        // Second prompt: fallback response
        const text = promptCount === 1
          ? '{"is_refusal": true, "reason": "content policy"}'
          : "The real answer.";
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text }],
          usage: makeUsage(),
          stopReason: "stop",
        });
        callbacks.forEach((cb) => cb({ type: "message_end", message: session.messages.at(-1) }));
        callbacks.forEach((cb) => cb({ type: "turn_end" }));
      }),
    };

    const agent = { setModel: vi.fn() };
    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent,
      ensureProviderKey: vi.fn(async () => {}),
      responseTimestamp: { lastResponseAt: 0 },
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",
      authStorage: AuthStorage.inMemory(),
      logger: minimalLogger,
      modelAdapter: {
        resolve: (spec: string) => ({
          spec: { provider: spec.split(":")[0], modelId: spec.split(":")[1] },
          model: { provider: spec.split(":")[0], id: spec.split(":")[1] },
        }),
      } as any,
      onResponse: (text: string) => { deliveredTexts.push(text); },
    });

    const result = await runner.prompt("hello", { refusalFallbackModel: "anthropic:claude-sonnet-4" });

    // First message has no suffix (before fallback), second has the suffix
    expect(deliveredTexts[0]).not.toContain("[refusal fallback");
    expect(deliveredTexts[1]).toContain("[refusal fallback to claude-sonnet-4]");
    expect(result.text).toBe("The real answer.");
    expect(result.refusalFallbackActivated).toBe(true);
  });

  it("recovers text from earlier message when last assistant message is aborted/empty", async () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "the real answer" }],
          usage: makeUsage(),
          stopReason: "stop",
        },
        {
          role: "user",
          content: [{ type: "text", text: "<meta>iteration limit</meta>" }],
        },
        {
          role: "assistant",
          content: [],
          usage: makeUsage(),
          stopReason: "aborted",
          errorMessage: "Request was aborted.",
        },
      ] as any[],
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => {}),
    };

    mockCreateAgentSessionForInvocation.mockReturnValue({
      session,
      agent: { setModel: vi.fn() },
      ensureProviderKey: vi.fn(async () => {}),
      responseTimestamp: { lastResponseAt: 0 },
      getVisionFallbackActivated: () => false,
    });

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "sys",
      authStorage: AuthStorage.inMemory(),
      logger: minimalLogger,
      modelAdapter: minimalModelAdapter,
    });

    const result = await runner.prompt("hello");
    expect(result.text).toBe("the real answer");
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
        responseTimestamp: { lastResponseAt: 0 },
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
