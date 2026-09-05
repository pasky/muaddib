import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  streamSimpleMock: vi.fn((_model, _context, options) => {
    options?.onPayload?.({ hello: "world" });
    return { stream: true, result: () => new Promise(() => {}) };
  }),
  sessions: [] as any[],
  appendMessage: vi.fn(),
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    public state: any = { model: null, messages: [], systemPrompt: "" };
    public steer = vi.fn();
    public hasQueuedMessages = vi.fn(() => false);

    constructor(public readonly config: any) {}
  },
}));

vi.mock("../src/models/pi-ai-models.js", () => ({
  piAiModels: {
    streamSimple: (model: unknown, context: unknown, options: unknown) =>
      mockState.streamSimpleMock(model, context, options),
  },
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
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
  SessionManager: {
    inMemory: vi.fn(() => ({
      type: "sessionManager",
      getSessionFile: () => undefined,
      getSessionId: () => "mock-session-id",
      appendMessage: mockState.appendMessage,
    })),
    open: vi.fn((path: string) => ({
      type: "sessionManager",
      getSessionFile: () => path,
      getSessionId: () => "mock-session-id",
      appendMessage: mockState.appendMessage,
      appendCustomEntry: vi.fn(),
      appendModelChange: vi.fn(),
      getBranch: () => [],
    })),
  },
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

async function getTransform(ctx: Awaited<ReturnType<typeof createAgentSessionForInvocation>>) {
  // The mocked Agent stores constructor options at agent.config
  return (ctx.agent as any).config.transformContext as
    (messages: unknown[]) => Promise<unknown[]>;
}

function hasMetaInLast(msgs: unknown[]): boolean {
  const last = msgs.at(-1) as { role?: string; content?: Array<{ type: string; text?: string }> } | undefined;
  if (!last || last.role !== "user") return false;
  return (last.content ?? []).some((c) => c.type === "text" && (c.text ?? "").includes("<meta>"));
}

/**
 * Play one assistant turn the way the real session does: the LLM call's final
 * message flows through the factory's streamFn (where usage is accounted),
 * then the session emits turn_end.
 */
async function emitTurn(session: any, event: { type: "turn_end"; message: any; toolResults: unknown[] }): Promise<void> {
  mockState.streamSimpleMock.mockReturnValueOnce({ stream: true, result: () => Promise.resolve(event.message) });
  session.agent.config.streamFn(session.agent.state.model, { messages: [] }, {});
  await Promise.resolve();
  session.emit(event);
}

/** Build a mock usage object for assistant messages. */
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

function fakeAuthStore() {
  return {
    getApiKey: vi.fn(async () => "test-key"),
    getModelRuntime: vi.fn(async () => ({})),
  } as any;
}

const defaultModelAdapter = { resolve: vi.fn(() => ({
  spec: { provider: "openai", modelId: "gpt-4o-mini" },
  model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
})) } as any;

describe("createAgentSessionForInvocation", () => {
  beforeEach(() => {
    mockState.sessions.length = 0;
    mockState.streamSimpleMock.mockClear();
    mockState.appendMessage.mockClear();
  });

  it("converts context messages and preserves provider/model metadata", async () => {
    const resolved = {
      spec: { provider: "openai", modelId: "gpt-4o-mini" },
      model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
    };

    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: { resolve: vi.fn(() => resolved) } as any,
      contextMessages: [
        { role: "user", content: "hello", timestamp: 0 },
        { role: "assistant", content: [{ type: "text" as const, text: "world" }], api: "", provider: "", model: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: 0 },
      ],
    });

    const agent = ctx.agent as any;
    const messages = agent.state.messages;
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("persists context messages as session entries so compaction can summarize them", async () => {
    await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: defaultModelAdapter,
      contextMessages: [
        { role: "user", content: "hello", timestamp: 0 },
        { role: "user", content: "world", timestamp: 0 },
      ],
      sessionFile: "/tmp/does-not-matter.jsonl",
    });

    // Compaction rebuilds agent.state.messages from session entries; context
    // messages that never became entries would be silently dropped.
    expect(mockState.appendMessage).toHaveBeenCalledTimes(2);
    expect((mockState.appendMessage.mock.calls[0][0] as any).content).toBe("hello");
    expect((mockState.appendMessage.mock.calls[1][0] as any).content).toBe("world");
  });

  it("accumulates billed usage from turn events", async () => {
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxCostUsd: 10 },
    });
    const session = mockState.sessions[0];

    const turnEnd = (input: number, cost: number) => emitTurn(session, {
      type: "turn_end",
      message: { role: "assistant", content: [], stopReason: "stop", usage: mockUsage(input, 0, 0, cost) },
      toolResults: [],
    });

    await turnEnd(1_000, 0.02);
    await turnEnd(4_000, 0.03);

    const summary = ctx.takeUsage();
    expect(summary.usage.cost.total).toBeCloseTo(0.05, 5);
    expect(summary.usage.input).toBe(5_000);
    expect(summary.peakTurnInput).toBe(4_000);
  });

  it("rejects malformed session limits instead of silently defaulting them", async () => {
    const create = (sessionLimits: unknown) => createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: sessionLimits as any,
    });

    // null is a present-but-wrong value from JSON, not an absent one; a NaN
    // ceiling would compare false forever and leave the session unbounded.
    await expect(create({ maxCostUsd: null })).rejects.toThrow("sessionLimits.maxCostUsd must be a finite number > 0, got null.");
    await expect(create({ maxCostUsd: "2" })).rejects.toThrow('sessionLimits.maxCostUsd must be a finite number > 0, got "2".');
    await expect(create({ maxContextLength: 0 })).rejects.toThrow("sessionLimits.maxContextLength must be a finite number > 0, got 0.");
    await expect(create({ maxCostUsd: 2 })).resolves.toBeDefined();
  });

  it("imposes no context ceiling by default — only cost limits the session", async () => {
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxCostUsd: 10 },
    });

    const session = mockState.sessions[0];
    const transform = await getTransform(ctx);

    // A turn far beyond any model context window must not trip the soft limit;
    // pi's auto-compaction handles context pressure instead.
    await emitTurn(session, {
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "web_search", arguments: {} }],
        stopReason: "toolUse",
        usage: mockUsage(5_000_000, 0, 0, 0.01),
      },
      toolResults: [],
    });

    expect(hasMetaInLast(await transform(toolUseContext()))).toBe(false);
  });

  it("counts invocation turns from the preloaded-context boundary, and survives compaction rewriting it", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxCostUsd: 10 },
      thinkingLevel: "high",
      // Only the high-reasoning first-turn special case can fire, so the nudge
      // is a direct probe of the computed turn count.
      progressThresholdSeconds: 100_000,
      contextMessages: [
        // A past bot reply: preloaded assistant turns must not be counted as
        // turns of this invocation.
        {
          role: "assistant", content: [{ type: "text" as const, text: "earlier reply" }],
          api: "", provider: "", model: "", stopReason: "stop" as const, timestamp: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
        { role: "user", content: "latest channel line", timestamp: 0 },
      ],
      logger,
    });

    const session = mockState.sessions[0];
    const transform = await getTransform(ctx);
    const preloaded = (ctx.agent as any).state.messages as unknown[];

    // One assistant turn since the boundary → the high-reasoning first-turn
    // nudge fires. Counting the preloaded reply too would make it turn 2.
    const out = await transform([...preloaded, assistantToolCall(), toolResult()]);
    expect(hasMetaInLast(out)).toBe(true);
    expect((out.at(-1) as any).content[0].text).toContain("<status>");

    // Compaction rewrites the message list: the boundary message is gone, so
    // everything that remains counts as invocation content (still turn 1 here).
    session.emit({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: { summary: "s", firstKeptEntryId: "e1", tokensBefore: 250_000, estimatedTokensAfter: 20_000 },
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Context compacted"));

    const compacted = [userMsg("summary"), assistantToolCall(), toolResult()];
    const outAfter = await transform(compacted);
    expect(hasMetaInLast(outAfter)).toBe(true);
    expect((outAfter.at(-1) as any).content[0].text).toContain("<status>");
  });

  it("validates provider key via ensureProviderKey", async () => {
    const authStorage = {
      getApiKey: vi.fn(async (provider: string) => `${provider}-key`),
      getModelRuntime: vi.fn(async () => ({})),
    };
    const ctx = await createAgentSessionForInvocation({
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

  it("activates vision fallback model on image tool output and enforces session-limit abort", async () => {
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
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: { resolve } as any,
      visionFallbackModel: "anthropic:claude-sonnet-4",
      sessionLimits: { maxContextLength: 5000, maxCostUsd: 10 },
      logger,
    });

    const session = mockState.sessions[0];
    const agent = ctx.agent as any;

    session.emit({ type: "tool_execution_end", isError: false, result: { nested: [{ kind: "image" }] } });
    expect(agent.state.model).toEqual(visionModel);
    expect(ctx.getVisionFallbackActivated()).toBe(true);

    // After vision fallback activates, the next turn should switch loop config to
    // the vision model so pi-agent-core resolves that provider's API key.
    expect(agent.config.prepareNextTurn()).toEqual({ model: visionModel });

    // The streamFn also guards against stale loop model captures by using the vision model.
    mockState.streamSimpleMock.mockClear();
    const streamFn = agent.config.streamFn;
    const originalModel = { provider: "openai", id: "gpt-4o-mini", api: "responses" };
    streamFn(originalModel, { messages: [] }, {});
    expect(mockState.streamSimpleMock).toHaveBeenCalledTimes(1);
    expect(mockState.streamSimpleMock.mock.calls[0][0]).toBe(visionModel);

    // Turn 1 (toolUse, 3000 context tokens): peak=3000 < maxContextLength=5000 → no limit
    await emitTurn(session, {
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
    await emitTurn(session, {
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
      await emitTurn(session, {
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
    await emitTurn(session, {
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
    await emitTurn(session, {
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
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 1_000_000, maxCostUsd: 0.05 },
      logger,
    });

    const session = mockState.sessions[0];
    const agent = ctx.agent as any;
    const transform = await getTransform(ctx);

    // Turn 1: $0.03 → no limit yet
    await emitTurn(session, {
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
    await emitTurn(session, {
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

  it("streamFn uses original model when vision fallback is not activated", async () => {
    const resolve = vi.fn(() => ({
      spec: { provider: "openai", modelId: "gpt-4o-mini" },
      model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
    }));

    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
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
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
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
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 5000, maxCostUsd: 10 },
      metaReminder: REMINDER,
    });

    const session = mockState.sessions[0];
    const transform = await getTransform(ctx);

    // Simulate peak context exceeding the limit
    await emitTurn(session, {
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
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
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
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
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
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
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

  it("does not inject progress nudge after a non-tool assistant turn", async () => {
    await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 500_000, maxCostUsd: 10 },
      progressThresholdSeconds: 0,
    });

    const session = mockState.sessions[0];
    const agent = (session as any).agent;

    await emitTurn(session, {
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
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
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
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 10_000, maxCostUsd: 10 },
      progressThresholdSeconds: 0,
      thinkingLevel: "high",
    });

    const session = mockState.sessions[0];

    // Emit a turn_end with 8500 context tokens → 85% of 10k limit → near limit
    await emitTurn(session, {
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
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
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
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
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

  it("does not inject metaReminder when not configured", async () => {
    await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: defaultModelAdapter,
    });

    const session = mockState.sessions[0];
    const agent = (session as any).agent;

    await emitTurn(session, {
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
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 5000, maxCostUsd: 0.05 },
    });

    const session = mockState.sessions[0];

    const transform = await getTransform(ctx);

    // Emit usage that exceeds initial context limit (peak=6000 >= maxContextLength=5000)
    await emitTurn(session, {
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
    const ctx = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      authStorage: fakeAuthStore(),
      modelAdapter: defaultModelAdapter,
      sessionLimits: { maxContextLength: 100_000, maxCostUsd: 1.0 },
    });

    const session = mockState.sessions[0];
    const transform = await getTransform(ctx);

    // Peak context = 95k — just under the limit
    await emitTurn(session, {
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
    await emitTurn(session, {
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
