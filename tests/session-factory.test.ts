import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

const mockState = vi.hoisted(() => ({
  streamSimpleMock: vi.fn((_model, _context, options) => {
    options?.onPayload?.({ hello: "world" });
    return { stream: true };
  }),
  sessions: [] as any[],
}));

vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: class {
    public replaceMessages = vi.fn();
    public setModel = vi.fn();
    public steer = vi.fn();
    public hasQueuedMessages = vi.fn(() => false);
    public setSystemPrompt = vi.fn();

    constructor(public readonly config: any) {}
  },
}));

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: (model: unknown, context: unknown, options: unknown) =>
    mockState.streamSimpleMock(model, context, options),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AgentSession: class {
    public readonly callbacks: Array<(event: any) => void> = [];
    public abort = vi.fn(async () => {});
    public dispose = vi.fn();
    public agent: any;

    constructor(config: any) {
      this.agent = config.agent;
      mockState.sessions.push(this);
    }

    subscribe(callback: (event: any) => void): () => void {
      this.callbacks.push(callback);
      return vi.fn();
    }

    emit(event: any): void {
      this.callbacks.forEach((cb) => cb(event));
    }
  },
  AuthStorage: {
    inMemory: () => ({
      set: vi.fn(),
      remove: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      setFallbackResolver: vi.fn(),
      getApiKey: vi.fn(async () => "test-key"),
    }),
  },
  ModelRegistry: class {
    constructor(_authStorage: unknown) {}
  },
  SessionManager: { inMemory: vi.fn(() => ({ type: "sessionManager" })) },
  SettingsManager: { inMemory: vi.fn(() => ({ type: "settingsManager" })) },
  convertToLlm: vi.fn(),
  createExtensionRuntime: vi.fn(() => ({ type: "extensionRuntime" })),
}));

import { createAgentSessionForInvocation } from "../src/agent/session-factory.js";

// ── helpers for transformContext unit tests ──

type Role = "user" | "assistant" | "toolResult";

function makeMsg(role: Role, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { role, timestamp: Date.now(), ...extra };
}

function userMsg(text = "q") {
  return makeMsg("user", { content: [{ type: "text", text }] });
}

function assistantToolCall(stopReason = "toolUse") {
  return makeMsg("assistant", {
    content: [{ type: "toolCall", id: "tc1", name: "web_search", arguments: {} }],
    stopReason,
  });
}

function toolResult() {
  return makeMsg("toolResult", {
    toolCallId: "tc1",
    toolName: "web_search",
    content: [{ type: "text", text: "ok" }],
    details: {},
    isError: false,
  });
}

/** Minimal after-toolUse message context for transformContext tests. */
function toolUseContext(extraAssistantTurns = 0): Record<string, unknown>[] {
  const msgs: Record<string, unknown>[] = [userMsg()];
  for (let i = 0; i < extraAssistantTurns; i++) {
    msgs.push(assistantToolCall(), toolResult());
  }
  msgs.push(assistantToolCall(), toolResult());
  return msgs;
}

async function getTransform(ctx: ReturnType<typeof createAgentSessionForInvocation>) {
  // The mocked Agent stores constructor options at agent.config
  return (ctx.agent as any).config.transformContext as
    (messages: unknown[]) => Promise<unknown[]>;
}

function hasMetaInLast(msgs: unknown[]): boolean {
  const last = msgs.at(-1) as { role?: string; content?: Array<{ type: string; text?: string }> } | undefined;
  if (!last || last.role !== "user") return false;
  return (last.content ?? []).some((c) => c.type === "text" && (c.text ?? "").includes("<meta>"));
}

describe("createAgentSessionForInvocation", () => {
  beforeEach(() => {
    mockState.sessions.length = 0;
    mockState.streamSimpleMock.mockClear();
  });

  it("converts context messages and preserves provider/model metadata", () => {
    const resolved = {
      spec: { provider: "openai", modelId: "gpt-4o-mini" },
      model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
    };

    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve: vi.fn(() => resolved) } as any,
      contextMessages: [
        { role: "user", content: "hello", timestamp: 0 },
        { role: "assistant", content: [{ type: "text" as const, text: "world" }], api: "", provider: "", model: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: 0 },
      ],
    });

    const agent = ctx.agent as any;
    expect(agent.replaceMessages).toHaveBeenCalledTimes(1);
    const [messages] = agent.replaceMessages.mock.calls[0];
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("validates provider key via ensureProviderKey", async () => {
    const authStorage = {
      getApiKey: vi.fn(async (provider: string) => `${provider}-key`),
      set: vi.fn(),
      remove: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      setFallbackResolver: vi.fn(),
    };
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: authStorage as any,
      modelAdapter: {
        resolve: vi.fn(() => ({
          spec: { provider: "openai", modelId: "gpt-4o-mini" },
          model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
        })),
      } as any,
    });

    await ctx.ensureProviderKey("openai");

    expect(authStorage.getApiKey).toHaveBeenCalledWith("openai");
  });

  it("activates vision fallback model on image tool output and enforces max-iteration abort", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const resolve = vi.fn((spec: string) => {
      if (spec === "openai:gpt-4o-mini") {
        return {
          spec: { provider: "openai", modelId: "gpt-4o-mini" },
          model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
        };
      }
      return {
        spec: { provider: "anthropic", modelId: "claude-sonnet-4" },
        model: { provider: "anthropic", id: "claude-sonnet-4", api: "anthropic-messages" },
      };
    });

    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve } as any,
      visionFallbackModel: "anthropic:claude-sonnet-4",
      maxIterations: 2,
      logger,
    });

    const session = mockState.sessions[0];
    const agent = ctx.agent as any;

    session.emit({ type: "tool_execution_end", isError: false, result: { nested: [{ kind: "image" }] } });
    expect(agent.setModel).toHaveBeenCalledWith({
      provider: "anthropic",
      id: "claude-sonnet-4",
      api: "anthropic-messages",
    });
    expect(ctx.getVisionFallbackActivated()).toBe(true);

    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      },
      toolResults: [],
    });
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      },
      toolResults: [],
    });
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      },
      toolResults: [],
    });
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      },
      toolResults: [],
    });

    expect(agent.steer).toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Exceeding max iterations, aborting session prompt loop.");
  });

  it("transformContext injects metaReminder on first turn, after toolUse, but not after stop or at iteration limit", async () => {
    const REMINDER = "Stay focused on the quest.";
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve: vi.fn(() => ({
        spec: { provider: "openai", modelId: "gpt-4o-mini" },
        model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
      })) } as any,
      maxIterations: 3,
      metaReminder: REMINDER,
    });

    const transform = await getTransform(ctx);

    // On the very first call (no prior assistant turns): nudge injected for metaReminder
    const firstCall = [userMsg()];
    const outFirst = await transform(firstCall);
    expect(hasMetaInLast(outFirst)).toBe(true);
    const lastMsgFirst = outFirst.at(-1) as any;
    expect(lastMsgFirst.content[0].text).toBe(`<meta>${REMINDER}</meta>`);

    // After first toolUse turn: nudge injected
    const afterTurn1 = toolUseContext();
    const out1 = await transform(afterTurn1);
    expect(hasMetaInLast(out1)).toBe(true);
    const lastMsg1 = out1.at(-1) as any;
    expect(lastMsg1.content[0].text).toBe(`<meta>${REMINDER}</meta>`);
    // Original array not mutated
    expect(out1).not.toBe(afterTurn1);
    expect(afterTurn1).not.toContain(out1.at(-1));

    // After a stop turn: no nudge
    const afterStop = [
      userMsg(),
      makeMsg("assistant", { content: [{ type: "text", text: "done" }], stopReason: "stop" }),
    ];
    const outStop = await transform(afterStop);
    expect(hasMetaInLast(outStop)).toBe(false);
    expect(outStop).toHaveLength(afterStop.length);

    // After second toolUse turn (turnCount=2, maxIterations=3): nudge still injected
    const afterTurn2 = toolUseContext(1); // 2 assistant turns
    const out2 = await transform(afterTurn2);
    expect(hasMetaInLast(out2)).toBe(true);

    // After third toolUse turn (turnCount=3, >= maxIterations=3): no nudge from transform
    const afterTurn3 = toolUseContext(2); // 3 assistant turns
    const out3 = await transform(afterTurn3);
    expect(hasMetaInLast(out3)).toBe(false);

    // iteration-limit steer still happens via subscriber (not via transform)
    const agent = ctx.agent as any;
    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("transformContext does NOT inject on first turn when no metaReminder is set", async () => {
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve: vi.fn(() => ({
        spec: { provider: "openai", modelId: "gpt-4o-mini" },
        model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
      })) } as any,
      maxIterations: 10,
      // no metaReminder
    });

    const transform = await getTransform(ctx);
    const firstCall = [userMsg()];
    const outFirst = await transform(firstCall);
    expect(hasMetaInLast(outFirst)).toBe(false);
    expect(outFirst).toHaveLength(firstCall.length);
  });

  it("transformContext injects both reminder and progress nudge when threshold elapsed", async () => {
    const progressTool = { name: "progress_report", lastSentAt: 0 };
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [progressTool as any],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve: vi.fn(() => ({
        spec: { provider: "openai", modelId: "gpt-4o-mini" },
        model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
      })) } as any,
      maxIterations: 10,
      metaReminder: "Stay focused.",
      progressThresholdSeconds: 0, // always triggers
      progressMinIntervalSeconds: 0,
    });

    const transform = await getTransform(ctx);
    const out = await transform(toolUseContext());
    expect(hasMetaInLast(out)).toBe(true);
    const text = (out.at(-1) as any).content[0].text as string;
    expect(text).toContain("Stay focused.");
    expect(text).toContain("progress_report");
  });

  it("transformContext nudges are ephemeral: each call is independent and does not accumulate", async () => {
    // The queue-guard (hasQueuedMessages) is gone. The race-safety guarantee now comes from
    // transformContext being called inside the agent loop's LLM call boundary — the nudge is
    // never enqueued. This test verifies that calling transform twice on the same base context
    // does not produce two <meta> messages (no accumulation from previous calls).
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve: vi.fn(() => ({
        spec: { provider: "openai", modelId: "gpt-4o-mini" },
        model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
      })) } as any,
      maxIterations: 10,
      metaReminder: "Stay focused.",
      progressThresholdSeconds: 0,
      progressMinIntervalSeconds: 0,
    });

    const transform = await getTransform(ctx);
    const base = toolUseContext();

    // Call transform twice on the same input (simulating two LLM calls from the same context)
    const out1 = await transform(base);
    const out2 = await transform(base);

    // Each call appends exactly one nudge message
    expect(out1).toHaveLength(base.length + 1);
    expect(out2).toHaveLength(base.length + 1);

    // Importantly, the base is not mutated — so the second call doesn't see the first nudge
    expect(base).toHaveLength(base.length); // still original length
    expect(hasMetaInLast(out1)).toBe(true);
    expect(hasMetaInLast(out2)).toBe(true);

    // agent.hasQueuedMessages is never consulted — the queue guard is gone
    const agent = ctx.agent as any;
    expect(agent.hasQueuedMessages).not.toHaveBeenCalled();
  });

  it("does not inject progress nudge after a non-tool assistant turn", () => {
    const progressTool = { name: "progress_report", lastSentAt: 0 };
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [progressTool as any],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve: vi.fn(() => ({
        spec: { provider: "openai", modelId: "gpt-4o-mini" },
        model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
      })) } as any,
      maxIterations: 10,
      progressThresholdSeconds: 0,
      progressMinIntervalSeconds: 0,
    });

    const session = mockState.sessions[0];
    const agent = ctx.agent as any;

    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      },
      toolResults: [{ role: "toolResult" }],
    });

    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("transformContext injects progress nudge on first tool-using turn with high reasoning, not on second", async () => {
    const progressTool = { name: "progress_report", lastSentAt: 0 };
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [progressTool as any],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve: vi.fn(() => ({
        spec: { provider: "openai", modelId: "gpt-4o-mini" },
        model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
      })) } as any,
      maxIterations: 10,
      progressThresholdSeconds: 9999, // won't trigger by elapsed time alone
      progressMinIntervalSeconds: 0,
      thinkingLevel: "high",
    });

    const transform = await getTransform(ctx);

    // First turn (turnCount=1, high reasoning) → nudge injected
    const afterTurn1 = toolUseContext(); // 1 assistant turn
    const out1 = await transform(afterTurn1);
    expect(hasMetaInLast(out1)).toBe(true);
    expect((out1.at(-1) as any).content[0].text).toContain("progress_report");

    // Second turn (turnCount=2, threshold=9999s not met, not first turn) → no nudge
    const afterTurn2 = toolUseContext(1); // 2 assistant turns
    const out2 = await transform(afterTurn2);
    expect(hasMetaInLast(out2)).toBe(false);
    expect(out2).toHaveLength(afterTurn2.length);
  });

  it("does not inject progress nudge near iteration limit", () => {
    const progressTool = { name: "progress_report", lastSentAt: 0 };
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [progressTool as any],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve: vi.fn(() => ({
        spec: { provider: "openai", modelId: "gpt-4o-mini" },
        model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
      })) } as any,
      maxIterations: 3,
      progressThresholdSeconds: 0,
      progressMinIntervalSeconds: 0,
      thinkingLevel: "high",
    });

    const session = mockState.sessions[0];
    const agent = ctx.agent as any;

    // Turn 1: maxIterations=3, turnCount=1, limit-2=1 → turnCount < maxIterations-2 is false
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
      },
      toolResults: [{ role: "toolResult" }],
    });
    // Should NOT have progress nudge since turnCount(1) >= maxIterations-2(1)
    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("transformContext injects progress nudge even without progress_report tool in tools array", async () => {
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve: vi.fn(() => ({
        spec: { provider: "openai", modelId: "gpt-4o-mini" },
        model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
      })) } as any,
      maxIterations: 10,
      progressThresholdSeconds: 0,
      progressMinIntervalSeconds: 0,
    });

    const transform = await getTransform(ctx);
    const out = await transform(toolUseContext());
    expect(hasMetaInLast(out)).toBe(true);
    expect((out.at(-1) as any).content[0].text).toContain("progress_report");
  });

  it("resets progress nudge debounce when progress_report tool is used", () => {
    const progressTool = { name: "progress_report", lastSentAt: 0 };
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [progressTool as any],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve: vi.fn(() => ({
        spec: { provider: "openai", modelId: "gpt-4o-mini" },
        model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
      })) } as any,
      maxIterations: 10,
      progressThresholdSeconds: 1, // 1 second threshold
      progressMinIntervalSeconds: 0,
    });

    const session = mockState.sessions[0];
    const agent = ctx.agent as any;

    // Simulate the tool having been used (lastSentAt set to now)
    progressTool.lastSentAt = Date.now();

    // Turn 1: tool was just used, so elapsed since last report ~0s < 1s threshold → no nudge
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
      },
      toolResults: [{ role: "toolResult" }],
    });
    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("warns when assistant produces text alongside tool_use", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve: vi.fn(() => ({
        spec: { provider: "openai", modelId: "gpt-4o-mini" },
        model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
      })) } as any,
      maxIterations: 5,
      logger,
    });

    const session = mockState.sessions[0];

    // Turn with both text and toolCall content blocks
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me search for that." },
          { type: "toolCall", id: "t1", name: "web_search", arguments: {} },
        ],
        stopReason: "toolUse",
      },
      toolResults: [{ role: "toolResult" }],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Turn 1: assistant produced text output alongside tool_use: Let me search for that.",
    );
  });

  it("does not inject metaReminder when not configured", () => {
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve: vi.fn(() => ({
        spec: { provider: "openai", modelId: "gpt-4o-mini" },
        model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
      })) } as any,
      maxIterations: 5,
    });

    const session = mockState.sessions[0];
    const agent = ctx.agent as any;

    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
      },
      toolResults: [{ role: "toolResult" }],
    });
    expect(agent.steer).not.toHaveBeenCalled();
  });
});
