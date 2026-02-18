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

    session.emit({ type: "turn_end" });
    session.emit({ type: "turn_end" });
    session.emit({ type: "turn_end" });
    session.emit({ type: "turn_end" });

    expect(agent.steer).toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Exceeding max iterations, aborting session prompt loop.");
  });

  it("injects metaReminder via steer on each turn before iteration limit", () => {
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
      metaReminder: "Stay focused on the quest.",
    });

    const session = mockState.sessions[0];
    const agent = ctx.agent as any;

    // Turn with tool results: should steer with reminder
    session.emit({ type: "turn_end", toolResults: [{ role: "toolResult" }] });
    expect(agent.steer).toHaveBeenCalledTimes(1);
    expect(agent.steer.mock.calls[0][0].content[0].text).toBe(
      "<meta>Stay focused on the quest.</meta>",
    );

    // Turn without tool results: no metaReminder steer
    agent.steer.mockClear();
    session.emit({ type: "turn_end", toolResults: [] });
    expect(agent.steer).not.toHaveBeenCalled();

    // Turn with tool results, still under limit
    session.emit({ type: "turn_end", toolResults: [{ role: "toolResult" }] });
    expect(agent.steer).toHaveBeenCalledTimes(1);

    // Fourth turn (at limit): iteration-limit steer only, no metaReminder
    agent.steer.mockClear();
    session.emit({ type: "turn_end", toolResults: [{ role: "toolResult" }] });
    expect(agent.steer).toHaveBeenCalledTimes(1);
    expect(agent.steer.mock.calls[0][0].content[0].text).toContain("iteration limit");
  });

  it("injects progress nudge when elapsed time exceeds threshold", async () => {
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

    const session = mockState.sessions[0];
    const agent = ctx.agent as any;

    session.emit({ type: "turn_end", toolResults: [{ role: "toolResult" }] });
    expect(agent.steer).toHaveBeenCalledTimes(1);
    const text = agent.steer.mock.calls[0][0].content[0].text;
    expect(text).toContain("Stay focused.");
    expect(text).toContain("progress_report");
  });

  it("injects progress nudge on first tool-using turn with high reasoning", () => {
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
      progressThresholdSeconds: 9999, // won't trigger by elapsed time
      progressMinIntervalSeconds: 0,
      thinkingLevel: "high",
    });

    const session = mockState.sessions[0];
    const agent = ctx.agent as any;

    // First turn with tool results + high reasoning → nudge
    session.emit({ type: "turn_end", toolResults: [{ role: "toolResult" }] });
    expect(agent.steer).toHaveBeenCalledTimes(1);
    expect(agent.steer.mock.calls[0][0].content[0].text).toContain("progress_report");

    // Second turn: no nudge (not first turn, threshold not met)
    agent.steer.mockClear();
    session.emit({ type: "turn_end", toolResults: [{ role: "toolResult" }] });
    expect(agent.steer).not.toHaveBeenCalled();
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
    session.emit({ type: "turn_end", toolResults: [{ role: "toolResult" }] });
    // Should NOT have progress nudge since turnCount(1) >= maxIterations-2(1)
    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("injects progress nudge even without progress_report tool in tools array", () => {
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

    const session = mockState.sessions[0];
    const agent = ctx.agent as any;

    session.emit({ type: "turn_end", toolResults: [{ role: "toolResult" }] });
    expect(agent.steer).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("progress_report"),
          }),
        ]),
      }),
    );
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
    session.emit({ type: "turn_end", toolResults: [{ role: "toolResult" }] });
    expect(agent.steer).not.toHaveBeenCalled();
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

    session.emit({ type: "turn_end", toolResults: [{ role: "toolResult" }] });
    expect(agent.steer).not.toHaveBeenCalled();
  });
});
