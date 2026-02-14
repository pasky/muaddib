import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  streamSimpleMock: vi.fn((_model, _context, options) => {
    options?.onPayload?.({ hello: "world" });
    return { stream: true };
  }),
  authStorageSetFallbackResolverMock: vi.fn(),
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
  AuthStorage: class {
    public set = vi.fn();
    public remove = vi.fn();
    public login = vi.fn();
    public logout = vi.fn();
    setFallbackResolver = (resolver: unknown) => mockState.authStorageSetFallbackResolverMock(resolver);
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
    mockState.authStorageSetFallbackResolverMock.mockClear();
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
      modelAdapter: { resolve: vi.fn(() => resolved) } as any,
      contextMessages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
    });

    const agent = ctx.agent as any;
    expect(agent.replaceMessages).toHaveBeenCalledTimes(1);
    const [messages] = agent.replaceMessages.mock.calls[0];
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].provider).toBe("openai");
    expect(messages[1].model).toBe("gpt-4o-mini");
  });

  it("caches provider keys via ensureProviderKey", async () => {
    const getApiKey = vi.fn(async (provider: string) => `  ${provider}-key  `);
    const ctx = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "system",
      tools: [],
      getApiKey,
      modelAdapter: {
        resolve: vi.fn(() => ({
          spec: { provider: "openai", modelId: "gpt-4o-mini" },
          model: { provider: "openai", id: "gpt-4o-mini", api: "responses" },
        })),
      } as any,
    });

    await ctx.ensureProviderKey("openai");
    await ctx.ensureProviderKey("openai");

    expect(getApiKey).toHaveBeenCalledTimes(1);
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
});
