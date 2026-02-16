/**
 * Shared helpers for E2E integration tests.
 *
 * Provides fake IRC transport classes, scripted LLM stream builders,
 * common config factories, and runtime construction utilities.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AssistantMessage,
  AssistantMessageEventStream,
  ToolCall,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai/dist/utils/event-stream.js";

import { RuntimeLogWriter } from "../../src/app/logging.js";
import { MuaddibConfig } from "../../src/config/muaddib-config.js";
import { ChatHistoryStore } from "../../src/history/chat-history-store.js";
import { PiAiModelAdapter } from "../../src/models/pi-ai-model-adapter.js";
import { IrcRoomMonitor } from "../../src/rooms/irc/monitor.js";
import type { MuaddibRuntime } from "../../src/runtime.js";

// ── Fake IRC transport ──

export class FakeEventsClient {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async waitForEvents(): Promise<void> {}
  async receiveResponse(): Promise<Record<string, unknown> | null> {
    return null;
  }
}

export class FakeSender {
  sent: Array<{ target: string; message: string; server: string }> = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getServerNick(): Promise<string | null> {
    return "muaddib";
  }

  async sendMessage(target: string, message: string, server: string): Promise<boolean> {
    this.sent.push({ target, message, server });
    return true;
  }
}

// ── Scripted LLM stream builders ──

export function emptyUsage(): Usage {
  return {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };
}

export function makeAssistantMessage(
  text: string,
  stopReason: "stop" | "toolUse" = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: emptyUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

/** Build a factory that produces a scripted text-only AssistantMessageEventStream. */
export function textStream(text: string): () => AssistantMessageEventStream {
  return () => {
    const stream = createAssistantMessageEventStream();
    const partial = makeAssistantMessage(text);

    queueMicrotask(() => {
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
      stream.push({ type: "done", reason: "stop", message: partial });
    });

    return stream;
  };
}

/** Build a factory that produces a scripted tool-call AssistantMessageEventStream. */
export function toolCallStream(
  toolCall: ToolCall,
): () => AssistantMessageEventStream {
  return () => {
    const stream = createAssistantMessageEventStream();
    const partial: AssistantMessage = {
      role: "assistant",
      content: [toolCall],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: emptyUsage(),
      stopReason: "toolUse",
      timestamp: Date.now(),
    };

    queueMicrotask(() => {
      stream.push({ type: "start", partial });
      stream.push({ type: "toolcall_start", contentIndex: 0, partial });
      stream.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall,
        partial,
      });
      stream.push({ type: "done", reason: "toolUse", message: partial });
    });

    return stream;
  };
}

// ── streamSimple mock state ──

export interface StreamMockState {
  calls: Array<{ model: unknown; context: unknown }>;
  responses: Array<() => AssistantMessageEventStream>;
  callIndex: number;
}

export function createStreamMockState(): StreamMockState {
  return { calls: [], responses: [], callIndex: 0 };
}

export function resetStreamMock(state: StreamMockState): void {
  state.calls.length = 0;
  state.responses = [];
  state.callIndex = 0;
}

/** Handler for the mocked streamSimple — wire this into vi.mock. */
export function handleStreamSimpleCall(state: StreamMockState, ...args: unknown[]): AssistantMessageEventStream {
  state.calls.push({ model: args[0], context: args[1] });
  const factory = state.responses[state.callIndex];
  if (!factory) {
    throw new Error(`No scripted streamSimple response for call index ${state.callIndex}`);
  }
  state.callIndex += 1;
  return factory();
}

// ── Config factories ──

export function baseCommandConfig() {
  return {
    historySize: 40,
    defaultMode: "classifier:serious",
    modes: {
      serious: {
        model: "openai:gpt-4o-mini",
        prompt: "You are {mynick}.",
        triggers: {
          "!s": {},
        },
      },
    },
    modeClassifier: {
      model: "openai:gpt-4o-mini",
      labels: { EASY_SERIOUS: "!s" },
      fallbackLabel: "EASY_SERIOUS",
    },
  };
}

// ── Runtime / monitor construction ──

export interface E2EContext {
  tmpHome: string;
  history: ChatHistoryStore;
  sender: FakeSender;
}

export async function createE2EContext(): Promise<E2EContext> {
  const tmpHome = await mkdtemp(join(tmpdir(), "muaddib-e2e-"));
  const history = new ChatHistoryStore(":memory:", 20);
  await history.initialize();
  return { tmpHome, history, sender: new FakeSender() };
}

export function buildRuntime(
  ctx: E2EContext,
  configData: Record<string, unknown>,
  apiKeys?: Record<string, string>,
): MuaddibRuntime {
  const keys = apiKeys ?? { openai: "sk-fake-openai-key" };
  return {
    config: MuaddibConfig.inMemory(configData),
    history: ctx.history,
    modelAdapter: new PiAiModelAdapter(),
    getApiKey: (provider: string) => keys[provider],
    logger: new RuntimeLogWriter({
      muaddibHome: ctx.tmpHome,
      stdout: { write: () => true } as unknown as NodeJS.WriteStream,
    }),
  };
}

/**
 * Create an IrcRoomMonitor from runtime, swapping in fake varlink transports.
 * The config must include `rooms.irc.varlink.socketPath`.
 */
export function buildIrcMonitor(runtime: MuaddibRuntime, sender: FakeSender): IrcRoomMonitor {
  const monitor = IrcRoomMonitor.fromRuntime(runtime)[0];
  (monitor as any).varlinkEvents = new FakeEventsClient();
  (monitor as any).varlinkSender = sender;
  return monitor;
}
