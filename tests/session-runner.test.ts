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

// ---------------------------------------------------------------------------
// Shared test helpers — session mock + runner factory
// ---------------------------------------------------------------------------

interface MockSessionCtx {
  session: any;
  callbacks: Array<(event: any) => void>;
  agent: { setModel: ReturnType<typeof vi.fn> };
  ensureProviderKey: ReturnType<typeof vi.fn>;
}

/** Create a mock session wired to mockCreateAgentSessionForInvocation. */
function makeMockSession(opts: {
  promptImpl?: (ctx: MockSessionCtx) => Promise<void>;
  messages?: any[];
  visionFallbackActivated?: boolean;
  dispose?: ReturnType<typeof vi.fn>;
} = {}): MockSessionCtx {
  const callbacks: Array<(event: any) => void> = [];
  const session: any = {
    messages: opts.messages ?? ([] as any[]),
    subscribe: vi.fn((cb: (event: any) => void) => { callbacks.push(cb); return vi.fn(); }),
    prompt: vi.fn(),
  };
  if (opts.dispose) session.dispose = opts.dispose;
  const agent = { setModel: vi.fn() };
  const ensureProviderKey = vi.fn(async () => {});
  const ctx: MockSessionCtx = { session, callbacks, agent, ensureProviderKey };

  if (opts.promptImpl) {
    session.prompt.mockImplementation(() => opts.promptImpl!(ctx));
  }

  mockCreateAgentSessionForInvocation.mockReturnValue({
    session,
    agent,
    ensureProviderKey,
    responseTimestamp: { lastResponseAt: 0 },
    getVisionFallbackActivated: () => opts.visionFallbackActivated ?? false,
  });

  return ctx;
}

/** Emit standard events: tool call + assistant message + turn_end. */
function emitAssistantResponse(ctx: MockSessionCtx, text: string, opts?: {
  stopReason?: string;
  usageMultiplier?: number;
  withToolCall?: { name: string; isError?: boolean };
}): void {
  const { session, callbacks } = ctx;
  if (opts?.withToolCall) {
    callbacks.forEach((cb) => cb({ type: "tool_execution_start", toolName: opts.withToolCall!.name, args: {} }));
    callbacks.forEach((cb) => cb({
      type: "tool_execution_end", toolName: opts.withToolCall!.name,
      isError: opts.withToolCall!.isError ?? false,
      result: [{ type: "text", text: "ok" }],
    }));
  }
  session.messages.push({
    role: "assistant",
    content: [{ type: "text", text }],
    usage: makeUsage(opts?.usageMultiplier ?? 1),
    stopReason: opts?.stopReason ?? "stop",
  });
  callbacks.forEach((cb) => cb({ type: "message_end", message: session.messages.at(-1) }));
  callbacks.forEach((cb) => cb({ type: "turn_end" }));
}

const defaultModelAdapter = {
  resolve: (spec: string) => ({
    spec: { provider: spec.split(":")[0], modelId: spec.split(":")[1] },
    model: { provider: spec.split(":")[0], id: spec.split(":")[1] },
  }),
} as any;
const defaultLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function makeRunner(overrides: Record<string, any> = {}): SessionRunner {
  return new SessionRunner({
    model: "openai:gpt-4o-mini",
    systemPrompt: "sys",
    authStorage: AuthStorage.inMemory(),
    logger: defaultLogger(),
    modelAdapter: defaultModelAdapter,
    ...overrides,
  });
}

describe("SessionRunner", () => {
  beforeEach(() => {
    mockCreateAgentSessionForInvocation = vi.fn();
  });

  it("retries empty completions and aggregates usage/tool+turn counters", async () => {
    vi.useFakeTimers();
    try {
      const unsubscribe = vi.fn();
      const ctx = makeMockSession({
        promptImpl: async (c) => {
          c.callbacks.forEach((cb) => cb({ type: "turn_end" }));
          c.callbacks.forEach((cb) => cb({ type: "tool_execution_start", toolName: "bash", args: { x: 1 } }));
          c.callbacks.forEach((cb) => cb({
            type: "tool_execution_end", toolName: "bash", isError: false,
            result: [{ type: "text", text: "ok" }],
          }));

          const promptText = c.session.prompt.mock.lastCall?.[0] as string ?? "";
          if (promptText.includes("No valid text")) {
            c.session.messages.push({
              role: "assistant", content: [{ type: "text", text: "final answer" }],
              usage: makeUsage(2), stopReason: "stop",
            });
            c.callbacks.forEach((cb) => cb({ type: "message_end", message: c.session.messages.at(-1) }));
            return;
          }

          c.session.messages.push({
            role: "assistant", content: [{ type: "text", text: "   " }],
            usage: makeUsage(1), stopReason: "max_tokens",
          });
          c.callbacks.forEach((cb) => cb({ type: "message_end", message: c.session.messages.at(-1) }));
        },
      });
      // Override subscribe to track unsubscribe
      ctx.session.subscribe = vi.fn((cb: any) => { ctx.callbacks.push(cb); return unsubscribe; });

      const runner = makeRunner();
      const promise = runner.prompt("hello");
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.text).toBe("final answer");
      expect(result.iterations).toBe(2);
      expect(result.toolCallsCount).toBe(2);
      expect(result.usage.totalTokens).toBe(15);
      expect(result.peakTurnInput).toBe(16);
      expect(result.stopReason).toBe("stop");
      expect(ctx.ensureProviderKey).toHaveBeenCalledWith("openai");
      expect(unsubscribe).not.toHaveBeenCalled();
      await result.session!.dispose();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches to refusal fallback model when refusal error is detected", async () => {
    const ctx = makeMockSession();
    ctx.session.prompt
      .mockRejectedValueOnce(new Error("invalid_prompt for safety reasons"))
      .mockResolvedValue(undefined);
    ctx.session.messages.push({
      role: "assistant", content: [{ type: "text", text: "done" }],
      usage: makeUsage(), stopReason: "stop",
    });

    const runner = makeRunner();
    const result = await runner.prompt("hello", { refusalFallbackModel: "anthropic:claude-sonnet-4" });

    expect(result.refusalFallbackActivated).toBe(true);
    expect(result.refusalFallbackModel).toBe("anthropic:claude-sonnet-4");
    expect(ctx.ensureProviderKey).toHaveBeenCalledWith("anthropic");
    expect(ctx.agent.setModel).toHaveBeenCalledWith({ provider: "anthropic", id: "claude-sonnet-4" });
  });

  it("defers toolSet.dispose to session.dispose on success", async () => {
    const dispose = vi.fn(async () => {});
    makeMockSession({
      messages: [{ role: "assistant", content: [{ type: "text", text: "response" }], usage: makeUsage(), stopReason: "stop" }],
      dispose: vi.fn(async () => {}),
    });

    const runner = makeRunner({ toolSet: { tools: [], dispose } });
    const result = await runner.prompt("hello");
    expect(dispose).not.toHaveBeenCalled();
    await result.session!.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("does not double-dispose toolSet when session.dispose is called", async () => {
    const dispose = vi.fn(async () => {});
    makeMockSession({
      messages: [{ role: "assistant", content: [{ type: "text", text: "response" }], usage: makeUsage(), stopReason: "stop" }],
      dispose: vi.fn(async () => {}),
    });

    const runner = makeRunner({ toolSet: { tools: [], dispose } });
    const result = await runner.prompt("hello");
    await result.session!.dispose();
    await result.session!.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("calls toolSet.dispose in finally block when prompt throws", async () => {
    const dispose = vi.fn(async () => {});
    makeMockSession({
      promptImpl: async () => { throw new Error("network failure"); },
    });

    const runner = makeRunner({ toolSet: { tools: [], dispose } });
    await expect(runner.prompt("hello")).rejects.toThrow("network failure");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("logs full assistant metadata and preserves long content text/thinking in message_end debug", async () => {
    const longText = "L".repeat(5000);
    const longThinking = "T".repeat(5000);
    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: longText, textSignature: "sig-text" },
        { type: "thinking", thinking: longThinking, thinkingSignature: "sig-thinking" },
        { type: "toolCall", id: "tool-1", name: "web_search", arguments: { query: "muaddib" }, thoughtSignature: "sig-tool" },
      ],
      usage: makeUsage(3), stopReason: "length",
      api: "openai-responses", provider: "openai", model: "gpt-4o-mini",
      errorMessage: "hit token limit", timestamp: 123, extraField: { nested: true },
    };

    const ctx = makeMockSession({
      promptImpl: async (c) => {
        c.session.messages.push(assistantMessage);
        c.callbacks.forEach((cb) => cb({ type: "turn_end" }));
        c.callbacks.forEach((cb) => cb({ type: "message_end", message: assistantMessage }));
      },
    });
    const unsubscribe = vi.fn();
    ctx.session.subscribe = vi.fn((cb: any) => { ctx.callbacks.push(cb); return unsubscribe; });

    const logger = defaultLogger();
    const runner = makeRunner({ logger, llmDebugMaxChars: 20_000 });
    await runner.prompt("hello");

    const responseLogCall = logger.debug.mock.calls.find(
      (args) => args[0] === "llm_io response agent_stream",
    );
    expect(responseLogCall).toBeDefined();

    const payload = JSON.parse(String(responseLogCall?.[1]));
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
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("appends toolSet.systemPromptSuffix to system prompt passed to LLM", async () => {
    makeMockSession({
      messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], usage: makeUsage(), stopReason: "stop" }],
    });

    const runner = makeRunner({
      systemPrompt: "base prompt",
      toolSet: { tools: [], systemPromptSuffix: "Filesystem: /workspace persists; /workspace/.sessions/session-abc is your working directory." },
    });
    await runner.prompt("hello");

    const calledWith = mockCreateAgentSessionForInvocation.mock.calls[0]![0] as { systemPrompt: string };
    expect(calledWith.systemPrompt).toBe("base prompt\n\nFilesystem: /workspace persists; /workspace/.sessions/session-abc is your working directory.");
  });

  it("passes system prompt unchanged when toolSet has no systemPromptSuffix", async () => {
    makeMockSession({
      messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], usage: makeUsage(), stopReason: "stop" }],
    });

    const runner = makeRunner({ systemPrompt: "base prompt", toolSet: { tools: [] } });
    await runner.prompt("hello");

    const calledWith = mockCreateAgentSessionForInvocation.mock.calls[0]![0] as { systemPrompt: string };
    expect(calledWith.systemPrompt).toBe("base prompt");
  });

  it("fires onResponse for every non-empty assistant text including the final one", async () => {
    const deliveredTexts: string[] = [];
    makeMockSession({
      promptImpl: async (c) => {
        emitAssistantResponse(c, "Let me search for that.", { stopReason: "tool_use", withToolCall: { name: "web_search" } });
        emitAssistantResponse(c, "Here is the final answer.");
      },
    });

    const runner = makeRunner({ onResponse: (text: string) => { deliveredTexts.push(text); } });
    const result = await runner.prompt("hello");

    expect(deliveredTexts).toEqual(["Let me search for that.", "Here is the final answer."]);
    expect(result.text).toBe("Here is the final answer.");
  });

  it("delivers final assistant text even if message_end is missing", async () => {
    const deliveredTexts: string[] = [];
    makeMockSession({
      promptImpl: async (c) => {
        c.session.messages.push({
          role: "assistant", content: [{ type: "text", text: "Final without message_end." }],
          usage: makeUsage(), stopReason: "stop",
        });
        c.callbacks.forEach((cb) => cb({ type: "turn_end" }));
      },
    });

    const runner = makeRunner({ onResponse: (text: string) => { deliveredTexts.push(text); } });
    const result = await runner.prompt("hello");

    expect(result.text).toBe("Final without message_end.");
    expect(deliveredTexts).toEqual(["Final without message_end."]);
  });

  it("awaits async onResponse delivery before prompt resolves", async () => {
    vi.useFakeTimers();
    try {
      const deliveredTexts: string[] = [];
      makeMockSession({
        promptImpl: async (c) => { emitAssistantResponse(c, "Delayed response."); },
      });

      const runner = makeRunner({
        onResponse: async (text: string) => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          deliveredTexts.push(text);
        },
      });

      const promptPromise = runner.prompt("hello");
      await vi.runAllTicks();

      let settled = false;
      void promptPromise.then(() => { settled = true; });

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
    const deliveredTexts: string[] = [];
    makeMockSession({
      promptImpl: async (c) => {
        // Turn 1: whitespace-only text + tool call
        c.session.messages.push({
          role: "assistant", content: [{ type: "text", text: "   " }],
          usage: makeUsage(), stopReason: "tool_use",
        });
        c.callbacks.forEach((cb) => cb({ type: "message_end", message: c.session.messages.at(-1) }));
        c.callbacks.forEach((cb) => cb({ type: "tool_execution_start", toolName: "bash", args: {} }));
        c.callbacks.forEach((cb) => cb({ type: "tool_execution_end", toolName: "bash", isError: false, result: "ok" }));
        c.callbacks.forEach((cb) => cb({ type: "turn_end" }));
        // Turn 2: final response
        emitAssistantResponse(c, "Done.");
      },
    });

    const runner = makeRunner({ onResponse: (text: string) => { deliveredTexts.push(text); } });
    const result = await runner.prompt("hello");

    expect(deliveredTexts).toEqual(["Done."]);
    expect(result.text).toBe("Done.");
  });

  it("does not fire onResponse for session reuse (e.g. memory update) after main prompt returns", async () => {
    const deliveredTexts: string[] = [];
    const logger = defaultLogger();
    const ctx = makeMockSession({
      promptImpl: async (c) => { emitAssistantResponse(c, "Main response."); },
    });

    const runner = makeRunner({ logger, onResponse: (text: string) => { deliveredTexts.push(text); } });
    const result = await runner.prompt("hello");

    expect(deliveredTexts).toEqual(["Main response."]);
    expect(result.muteResponses).toBeTypeOf("function");
    result.muteResponses!();

    // Simulate memory update: reuse the returned session for a follow-up prompt
    ctx.session.prompt.mockImplementation(async () => { emitAssistantResponse(ctx, "Memory updated."); });
    await result.session!.prompt("update memory");

    expect(deliveredTexts).toEqual(["Main response."]);
    const infoArgs = logger.info.mock.calls.map((c: any[]) => c[0]);
    expect(infoArgs).toContain("Suppressing post-response text");
  });

  it("appends refusal fallback suffix to messages after fallback activates", async () => {
    const deliveredTexts: string[] = [];
    let promptCount = 0;
    makeMockSession({
      promptImpl: async (c) => {
        promptCount += 1;
        const text = promptCount === 1
          ? '{"is_refusal": true, "reason": "content policy"}'
          : "The real answer.";
        emitAssistantResponse(c, text);
      },
    });

    const runner = makeRunner({ onResponse: (text: string) => { deliveredTexts.push(text); } });
    const result = await runner.prompt("hello", { refusalFallbackModel: "anthropic:claude-sonnet-4" });

    expect(deliveredTexts[0]).not.toContain("[refusal fallback");
    expect(deliveredTexts[1]).toContain("[refusal fallback to claude-sonnet-4]");
    expect(result.text).toBe("The real answer.");
    expect(result.refusalFallbackActivated).toBe(true);
  });

  it("recovers text from earlier message when last assistant message is aborted/empty", async () => {
    makeMockSession({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "the real answer" }], usage: makeUsage(), stopReason: "stop" },
        { role: "user", content: [{ type: "text", text: "<meta>iteration limit</meta>" }] },
        { role: "assistant", content: [], usage: makeUsage(), stopReason: "aborted", errorMessage: "Request was aborted." },
      ],
    });

    const runner = makeRunner();
    const result = await runner.prompt("hello");
    expect(result.text).toBe("the real answer");
  });

  it("throws when completion remains empty after retries", async () => {
    vi.useFakeTimers();
    try {
      makeMockSession({
        messages: [{ role: "assistant", content: [{ type: "text", text: "   " }], usage: makeUsage(), stopReason: "stop" }],
      });

      const runner = makeRunner();
      const promise = runner.prompt("hello");
      const assertion = expect(promise).rejects.toThrow("Agent produced empty completion after 3 retries.");
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { response: "NULL", expected: "NULL", desc: "NULL sentinel is not decorated" },
    { response: "Here is the analysis.", expected: "Here is the analysis. [vision fallback to kimi-k2.5]", desc: "normal response gets suffix" },
  ])("vision fallback suffix: $desc", async ({ response, expected }) => {
    vi.useFakeTimers();
    try {
      const deliveredTexts: string[] = [];
      makeMockSession({
        visionFallbackActivated: true,
        promptImpl: async (c) => {
          emitAssistantResponse(c, response, { withToolCall: { name: "read" } });
        },
      });

      const runner = makeRunner({
        onResponse: async (text: string) => { deliveredTexts.push(text); },
      });
      const promise = runner.prompt("hello", { visionFallbackModel: "moonshotai:kimi-k2.5" });
      await vi.runAllTimersAsync();
      await promise;
      expect(deliveredTexts).toEqual([expected]);
    } finally {
      vi.useRealTimers();
    }
  });
});
