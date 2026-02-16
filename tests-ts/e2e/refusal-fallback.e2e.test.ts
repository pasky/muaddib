/**
 * E2E test: Refusal → fallback → annotated response (Scenario #3)
 *
 * Exercises the full pipeline from IrcRoomMonitor.processMessageEvent through
 * the real RoomMessageHandler, CommandExecutor, SessionRunner, and Agent loop.
 *
 * Mock boundaries:
 *   - `streamSimple` from `@mariozechner/pi-ai` (scripted LLM responses)
 *   - `getApiKey` on runtime (returns fake keys)
 *
 * Verification:
 *   - FakeSender.sent contains the response with `[refusal fallback to ...]`
 *   - ChatHistoryStore has the persisted messages
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai/dist/utils/event-stream.js";

import { RuntimeLogWriter } from "../../src/app/logging.js";
import { MuaddibConfig } from "../../src/config/muaddib-config.js";
import { ChatHistoryStore } from "../../src/history/chat-history-store.js";
import { PiAiModelAdapter } from "../../src/models/pi-ai-model-adapter.js";
import { IrcRoomMonitor } from "../../src/rooms/irc/monitor.js";
import type { MuaddibRuntime } from "../../src/runtime.js";

// ── Mock streamSimple ──

const streamSimpleCalls: Array<{ model: unknown; context: unknown }> = [];
let streamResponses: Array<() => AssistantMessageEventStream> = [];
let streamCallIndex = 0;

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    streamSimple: (...args: unknown[]) => {
      streamSimpleCalls.push({ model: args[0], context: args[1] });
      const factory = streamResponses[streamCallIndex];
      if (!factory) {
        throw new Error(`No scripted streamSimple response for call index ${streamCallIndex}`);
      }
      streamCallIndex += 1;
      return factory();
    },
    completeSimple: async () => {
      // Not used in this test (explicit !s trigger bypasses classifier)
      throw new Error("completeSimple should not be called in this test");
    },
  };
});

// ── Helpers ──

function emptyUsage(): Usage {
  return {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };
}

function makeAssistantMessage(
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

/**
 * Build a scripted text-only stream response.
 */
function textStream(text: string): () => AssistantMessageEventStream {
  return () => {
    const stream = createAssistantMessageEventStream();
    const partial = makeAssistantMessage(text);

    // Push events asynchronously so the consumer can start iterating
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

class FakeEventsClient {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async waitForEvents(): Promise<void> {}
  async receiveResponse(): Promise<Record<string, unknown> | null> {
    return null;
  }
}

class FakeSender {
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

// ── Test suite ──

describe("E2E: Refusal → fallback → annotated response", () => {
  let tmpHome: string;
  let history: ChatHistoryStore;
  let sender: FakeSender;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "muaddib-e2e-refusal-"));
    history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();
    sender = new FakeSender();

    streamSimpleCalls.length = 0;
    streamResponses = [];
    streamCallIndex = 0;
  });

  afterEach(async () => {
    await history.close();
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("detects refusal, switches to fallback model, and annotates response", async () => {
    // Script LLM responses:
    // 1. Primary model returns refusal text
    // 2. Fallback model returns actual answer
    streamResponses = [
      textStream('{"is_refusal": true, "reason": "content policy"}'),
      textStream("The answer to your question is 42."),
    ];

    const configData = {
      providers: {
        openai: { apiKey: "sk-fake-openai-key" },
        anthropic: { apiKey: "sk-fake-anthropic-key" },
      },
      router: {
        refusalFallbackModel: "anthropic:claude-3-5-sonnet-20241022",
      },
      rooms: {
        common: {
          command: {
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
          },
        },
        irc: {
          command: { historySize: 40 },
          varlink: { socketPath: "/tmp/muaddib-e2e-fake.sock" },
        },
      },
    };

    const runtime: MuaddibRuntime = {
      config: MuaddibConfig.inMemory(configData),
      history,
      modelAdapter: new PiAiModelAdapter(),
      getApiKey: (provider: string) => {
        const keys: Record<string, string> = {
          openai: "sk-fake-openai-key",
          anthropic: "sk-fake-anthropic-key",
        };
        return keys[provider];
      },
      logger: new RuntimeLogWriter({
        muaddibHome: tmpHome,
        stdout: { write: () => true } as unknown as NodeJS.WriteStream,
      }),
    };

    const monitor = IrcRoomMonitor.fromRuntime(runtime)[0];
    // Swap in fake varlink clients
    (monitor as any).varlinkEvents = new FakeEventsClient();
    (monitor as any).varlinkSender = sender;

    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "alice",
      message: "muaddib: !s What is the meaning of life?",
    });

    // Verify streamSimple was called twice (primary + fallback)
    expect(streamSimpleCalls).toHaveLength(2);

    // Verify FakeSender got the response with refusal fallback annotation
    expect(sender.sent.length).toBeGreaterThanOrEqual(1);
    const mainResponse = sender.sent[0];
    expect(mainResponse.target).toBe("#test");
    expect(mainResponse.server).toBe("libera");
    expect(mainResponse.message).toContain("The answer to your question is 42.");
    expect(mainResponse.message).toContain("[refusal fallback to");
    expect(mainResponse.message).toContain("claude-3-5-sonnet-20241022");

    // Verify history has the persisted messages
    const historyRows = await history.getFullHistory("libera", "#test");
    expect(historyRows.length).toBeGreaterThanOrEqual(2); // user message + bot response
    const botMessage = historyRows.find((row) => row.nick === "muaddib");
    expect(botMessage).toBeDefined();
    expect(botMessage!.message).toContain("The answer to your question is 42.");
    expect(botMessage!.message).toContain("[refusal fallback to");
  }, 30_000);
});
