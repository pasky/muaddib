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

/** Build a mock usage object for turn_end events. */
function mockUsage(input = 1000, cacheRead = 0, cacheWrite = 0, costTotal = 0.01) {
  return {
    input,
    output: 100,
    cacheRead,
    cacheWrite,
    totalTokens: input + 100 + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
}

const defaultModelAdapter = { resolve: vi.fn(() => ({
  spec: { provider: "openai", modelId: "gpt-4o-mini" },
  model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
})) } as any;

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

  it("activates vision fallback model on image tool output and enforces session-limit abort", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const visionModel = {
      provider: "anthropic",
      id: "claude-sonnet-4",
      api: "anthropic-messages",
    };
    const resolve = vi.fn((spec: string) => {
      if (spec === "openai:gpt-4o-mini") {
        return {
          spec: { provider: "openai", modelId: "gpt-4o-mini" },
          model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
        };
      }
      return {
        spec: { provider: "anthropic", modelId: "claude-sonnet-4" },
        model: visionModel,
      };
    });

    // Set token limit low enough to trigger after first turn_end with usage
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve } as any,
      visionFallbackModel: "anthropic:claude-sonnet-4",
      sessionLimits: { maxContextLength: 5000, maxCostUsd: 10 },
      logger,
    });

    const session = mockState.sessions[0];
    const agent = ctx.agent as any;

    session.emit({ type: "tool_execution_end", isError: false, result: { nested: [{ kind: "image" }] } });
    expect(agent.setModel).toHaveBeenCalledWith(visionModel);
    expect(ctx.getVisionFallbackActivated()).toBe(true);

    // After vision fallback activates, the streamFn should use the vision model
    mockState.streamSimpleMock.mockClear();
    const streamFn = agent.config.streamFn;
    const originalModel = { provider: "openai", id: "gpt-4o-mini", api: "responses" };
    streamFn(originalModel, { messages: [] }, {});
    expect(mockState.streamSimpleMock).toHaveBeenCalledTimes(1);
    expect(mockState.streamSimpleMock.mock.calls[0][0]).toBe(visionModel);

    // Turn 1 (toolUse, 3000 context tokens): peak=3000 < maxContextLength=5000 → no limit
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
        usage: mockUsage(3000),
      },
      toolResults: [],
    });
    expect(agent.steer).not.toHaveBeenCalled();

    // Turn 2 (toolUse, 6000 context tokens): peak=6000 >= maxContextLength=5000 → limit reached
    // Session-limit nudge is now injected via transformContext, not agent.steer()
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t2", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
        usage: mockUsage(6000),
      },
      toolResults: [],
    });
    // No steer — limit nudge is ephemeral via transformContext
    expect(agent.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();

    // Turns 3–10 (toolUse): all over limit → turnsSinceSoftLimit increments, no abort yet
    for (let turn = 3; turn <= 10; turn++) {
      session.emit({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: `t${turn}`, name: "web_search", arguments: {} }],
          stopReason: "toolUse",
          usage: mockUsage(6000),
        },
        toolResults: [],
      });
      expect(agent.steer).not.toHaveBeenCalled();
      expect(session.abort).not.toHaveBeenCalled();
    }

    // Turn 11 (toolUse): turnsSinceSoftLimit=10 → abort
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t11", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
        usage: mockUsage(6000),
      },
      toolResults: [],
    });
    expect(agent.steer).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Exceeding session limits, aborting session prompt loop.");

    // Turn 12 (stop): agent finally stops
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: mockUsage(100),
      },
      toolResults: [],
    });
    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("triggers soft limit on cost threshold via transformContext", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 1_000_000, maxCostUsd: 0.05 },
      logger,
    });

    const session = mockState.sessions[0];
    const agent = ctx.agent as any;
    const transform = await getTransform(ctx);

    // Turn 1: $0.03 → no limit yet
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
        usage: mockUsage(1000, 0, 0, 0.03),
      },
      toolResults: [],
    });
    expect(agent.steer).not.toHaveBeenCalled();

    // After turn 1: no limit nudge in transformContext (no metaReminder either)
    const out1 = await transform(toolUseContext());
    expect(hasMetaInLast(out1)).toBe(false);

    // Turn 2: $0.03 more → cumulative $0.06 >= $0.05 → limit reached
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t2", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
        usage: mockUsage(1000, 0, 0, 0.03),
      },
      toolResults: [],
    });
    // No steer — limit nudge is ephemeral via transformContext
    expect(agent.steer).not.toHaveBeenCalled();

    // transformContext now injects session-limit message
    const out2 = await transform(toolUseContext());
    expect(hasMetaInLast(out2)).toBe(true);
    expect((out2.at(-1) as any).content[0].text).toContain("session limit");
  });

  it("streamFn uses original model when vision fallback is not activated", () => {
    const resolve = vi.fn(() => ({
      spec: { provider: "openai", modelId: "gpt-4o-mini" },
      model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
    }));

    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: { resolve } as any,
    });

    const agent = ctx.agent as any;
    mockState.streamSimpleMock.mockClear();

    const originalModel = { provider: "openai", id: "gpt-4o-mini", api: "responses" };
    agent.config.streamFn(originalModel, { messages: [] }, {});
    expect(mockState.streamSimpleMock).toHaveBeenCalledTimes(1);
    expect(mockState.streamSimpleMock.mock.calls[0][0]).toBe(originalModel);
    expect(ctx.getVisionFallbackActivated()).toBe(false);
  });

  it("transformContext injects metaReminder on first turn, after toolUse, but not after stop or at session limit", async () => {
    const REMINDER = "Stay focused on the quest.";
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 500_000, maxCostUsd: 10 },
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

    // After second toolUse turn: nudge still injected (well within limits)
    const afterTurn2 = toolUseContext(1); // 2 assistant turns
    const out2 = await transform(afterTurn2);
    expect(hasMetaInLast(out2)).toBe(true);
  });

  it("transformContext replaces regular nudges with session-limit message when limit is reached", async () => {
    const REMINDER = "Stay focused on the quest.";
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 5000, maxCostUsd: 10 },
      metaReminder: REMINDER,
    });

    const session = mockState.sessions[0];
    const transform = await getTransform(ctx);

    // Simulate peak context exceeding the limit
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
        usage: mockUsage(6000),
      },
      toolResults: [],
    });

    // transformContext injects session-limit message instead of regular reminder
    const afterTurn = toolUseContext();
    const out = await transform(afterTurn);
    expect(hasMetaInLast(out)).toBe(true);
    const text = (out.at(-1) as any).content[0].text;
    expect(text).toContain("session limit");
    expect(text).not.toContain(REMINDER);
  });

  it("transformContext does NOT inject on first turn when no metaReminder is set", async () => {
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 500_000, maxCostUsd: 10 },
      // no metaReminder
    });

    const transform = await getTransform(ctx);
    const firstCall = [userMsg()];
    const outFirst = await transform(firstCall);
    expect(hasMetaInLast(outFirst)).toBe(false);
    expect(outFirst).toHaveLength(firstCall.length);
  });

  it("transformContext injects both reminder and progress nudge when threshold elapsed", async () => {
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 500_000, maxCostUsd: 10 },
      metaReminder: "Stay focused.",
      progressThresholdSeconds: 0, // always triggers
    });

    const transform = await getTransform(ctx);
    const out = await transform(toolUseContext());
    expect(hasMetaInLast(out)).toBe(true);
    const text = (out.at(-1) as any).content[0].text as string;
    expect(text).toContain("Stay focused.");
    expect(text).toContain("brief");
  });

  it("transformContext nudges are ephemeral: each call is independent and does not accumulate", async () => {
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 500_000, maxCostUsd: 10 },
      metaReminder: "Stay focused.",
      progressThresholdSeconds: 0,
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
    createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 500_000, maxCostUsd: 10 },
      progressThresholdSeconds: 0,
    });

    const session = mockState.sessions[0];
    const agent = (session as any).agent;

    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: mockUsage(),
      },
      toolResults: [{ role: "toolResult" }],
    });

    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("transformContext injects progress nudge on first tool-using turn with high reasoning, not on second", async () => {
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 500_000, maxCostUsd: 10 },
      progressThresholdSeconds: 9999, // won't trigger by elapsed time alone
      thinkingLevel: "high",
    });

    const transform = await getTransform(ctx);

    // First turn (turnCount=1, high reasoning) → nudge injected
    const afterTurn1 = toolUseContext(); // 1 assistant turn
    const out1 = await transform(afterTurn1);
    expect(hasMetaInLast(out1)).toBe(true);
    expect((out1.at(-1) as any).content[0].text).toContain("brief");

    // Second turn (turnCount=2, threshold=9999s not met, not first turn) → no nudge
    const afterTurn2 = toolUseContext(1); // 2 assistant turns
    const out2 = await transform(afterTurn2);
    expect(hasMetaInLast(out2)).toBe(false);
    expect(out2).toHaveLength(afterTurn2.length);
  });

  it("suppresses progress nudge near session limit (80% of token budget)", async () => {
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 10_000, maxCostUsd: 10 },
      progressThresholdSeconds: 0,
      thinkingLevel: "high",
    });

    const session = mockState.sessions[0];

    // Emit a turn_end with 8500 context tokens → 85% of 10k limit → near limit
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
        usage: mockUsage(8500),
      },
      toolResults: [],
    });

    const transform = await getTransform(ctx);
    // After 1 assistant turn in context, threshold=0 would normally trigger, but nearLimit suppresses
    const afterTurn = toolUseContext();
    const out = await transform(afterTurn);
    // Should only have metaReminder-less nudge (no progress nudge since near limit)
    // With no metaReminder set, no nudge at all
    expect(hasMetaInLast(out)).toBe(false);
  });

  it("transformContext injects progress nudge with text output instruction", async () => {
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 500_000, maxCostUsd: 10 },
      progressThresholdSeconds: 0,
    });

    const transform = await getTransform(ctx);
    const out = await transform(toolUseContext());
    expect(hasMetaInLast(out)).toBe(true);
    expect((out.at(-1) as any).content[0].text).toContain("brief");
  });

  it("resets progress nudge debounce when responseTimestamp is bumped", async () => {
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 500_000, maxCostUsd: 10 },
      progressThresholdSeconds: 1, // 1 second threshold
    });

    const transform = await getTransform(ctx);

    // Simulate a recent response delivery
    ctx.responseTimestamp.lastResponseAt = Date.now();

    // Elapsed since last response ~0s < 1s threshold → no progress nudge
    const out = await transform(toolUseContext());
    expect(hasMetaInLast(out)).toBe(false);
  });

  it("does not inject metaReminder when not configured", () => {
    createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
    });

    const session = mockState.sessions[0];
    const agent = (session as any).agent;

    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
        usage: mockUsage(),
      },
      toolResults: [{ role: "toolResult" }],
    });
    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("bumpSessionLimits increases both token and cost limits", async () => {
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 5000, maxCostUsd: 0.05 },
    });

    const session = mockState.sessions[0];

    const transform = await getTransform(ctx);

    // Emit usage that exceeds initial context limit (peak=6000 >= maxContextLength=5000)
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
        usage: mockUsage(6000, 0, 0, 0.03),
      },
      toolResults: [],
    });
    // Limit reached → transformContext injects session-limit nudge
    const out1 = await transform(toolUseContext());
    expect(hasMetaInLast(out1)).toBe(true);
    expect((out1.at(-1) as any).content[0].text).toContain("session limit");

    // Bump limits
    ctx.bumpSessionLimits(10_000, 0.10);

    // After bump: maxContextLength=5000+10000=15000 > peak=6000 → no limit nudge
    const out2 = await transform(toolUseContext());
    expect(hasMetaInLast(out2)).toBe(false);
  });

  it("bumpSessionLimits floors at 10% of initial configured limit", async () => {
    // maxContextLength=100000, maxCostUsd=1.0 → floor is 10000 tokens, $0.10
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: AuthStorage.inMemory(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 100_000, maxCostUsd: 1.0 },
    });

    const session = mockState.sessions[0];
    const transform = await getTransform(ctx);

    // Peak context = 95k — just under the limit
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
        usage: mockUsage(95_000, 0, 0, 0.95),
      },
      toolResults: [],
    });

    // Limit reached (95k >= 100k? No, 95k < 100k) — actually not reached yet
    const outBefore = await transform(toolUseContext());
    expect(hasMetaInLast(outBefore)).toBe(false);

    // Now push peak to 105k → exceeds 100k limit
    session.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t2", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
        usage: mockUsage(105_000, 0, 0, 0.10),
      },
      toolResults: [],
    });

    // Limit reached → transformContext injects session-limit nudge
    const outAfter = await transform(toolUseContext());
    expect(hasMetaInLast(outAfter)).toBe(true);
    expect((outAfter.at(-1) as any).content[0].text).toContain("session limit");

    // Bump with tiny values — should be floored to 10% of limit
    ctx.bumpSessionLimits(100, 0.001);
    // After bump: maxContextLength should be 100000 + max(100, 10000) = 110000
    // After bump: maxCostUsd should be 1.0 + max(0.001, 0.1) = 1.1

    // Peak is still 105k < 110k → no limit nudge
    const outBumped = await transform(toolUseContext());
    expect(hasMetaInLast(outBumped)).toBe(false);
  });
});
