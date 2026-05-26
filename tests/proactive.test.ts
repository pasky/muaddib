import { describe, expect, it, vi } from "vitest";
import type { Message, AssistantMessage } from "@earendil-works/pi-ai";

import {
  evaluateProactiveInterjection,
  ProactiveRunner,
  type ProactiveConfig,
  type ProactiveEvaluatorOptions,
} from "../src/rooms/command/proactive.js";
import { createStubAssistantFields } from "../src/history/chat-history-store.js";
import { buildArc, type RoomMessage } from "../src/rooms/message.js";

function userMsg(content: string): Message {
  return { role: "user", content, timestamp: 0 };
}

function assistantMsg(content: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    ...createStubAssistantFields(),
    timestamp: 0,
  };
}

const baseConfig: ProactiveConfig = {
  interjecting: ["irc.example.com#test"],
  debounceSeconds: 5,
  historySize: 20,
  rateLimit: 10,
  ratePeriod: 3600,
  interjectThreshold: 7,
  models: {
    validation: ["openai:gpt-4o-mini"],
    serious: "openai:gpt-4o",
  },
  prompts: {
    interject: "Evaluate: {message}",
    seriousExtra: "",
  },
};

const baseOptions: ProactiveEvaluatorOptions = {
  modelAdapter: {
    completeSimple: vi.fn(),
  } as any,
  mynick: "TestBot",
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
};

describe("evaluateProactiveInterjection", () => {
  it("returns false with empty context", async () => {
    const result = await evaluateProactiveInterjection(baseConfig, [], baseOptions);
    expect(result.shouldInterject).toBe(false);
    expect(result.reason).toContain("No context");
  });

  it("skips evaluation when last message is from the bot (assistant)", async () => {
    const context: Message[] = [
      userMsg("[14:30] <alice> hey bot, what's up?"),
      assistantMsg("[14:30] <TestBot> Not much, just chilling."),
    ];

    const completeSimple = vi.fn();
    const options = { ...baseOptions, modelAdapter: { completeSimple } as any };

    const result = await evaluateProactiveInterjection(baseConfig, context, options);

    expect(result.shouldInterject).toBe(false);
    expect(result.reason).toContain("bot");
    // The validation model should never be called.
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("proceeds with evaluation when last message is from a user", async () => {
    const context: Message[] = [
      assistantMsg("[14:28] <TestBot> previous response"),
      userMsg("[14:30] <alice> how do I configure systemd?"),
    ];

    const mockResponse: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[1. Technical question about systemd. 2. Yes. 3. Could explain Type=simple]: 8/10" }],
      ...createStubAssistantFields(),
      timestamp: Date.now(),
    };

    const completeSimple = vi.fn().mockResolvedValue(mockResponse);
    const options = { ...baseOptions, modelAdapter: { completeSimple } as any };

    const result = await evaluateProactiveInterjection(baseConfig, context, options);

    // Validation model should have been called.
    expect(completeSimple).toHaveBeenCalled();
    expect(result.shouldInterject).toBe(true);
  });
});

describe("ProactiveRunner.steerOrStart thread isolation", () => {
  function makeMessage(overrides: Partial<RoomMessage> = {}): RoomMessage {
    const serverTag = "slack.example.com";
    const channelName = "general";
    return {
      serverTag,
      channelName,
      arc: buildArc(serverTag, channelName),
      nick: "alice",
      mynick: "TestBot",
      content: "hello",
      trusted: true,
      ...overrides,
    };
  }

  function makeRunner(): ProactiveRunner {
    const config: ProactiveConfig = {
      ...baseConfig,
      interjecting: ["slack.example.com#general"],
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = {
      logger: { withMessageContext: vi.fn(async () => {}) },
      history: { countMessagesSince: vi.fn() },
      modelAdapter: {},
    } as any;
    const executor = {} as any;
    const resolver = {} as any;
    return new ProactiveRunner({ config, runtime, logger: logger as any, executor, resolver });
  }

  it("steers a passive message only into an agent in the same thread", () => {
    const runner = makeRunner();
    const steerCalls: any[] = [];
    const fakeAgentA: any = { steer: (m: any) => steerCalls.push({ key: "A", m }) };
    const fakeAgentB: any = { steer: (m: any) => steerCalls.push({ key: "B", m }) };

    // Inject two running proactive agents: one in thread-a, one in thread-b.
    (runner as any).activeAgents.set("slack.example.com#general\0*\0thread-a", fakeAgentA);
    (runner as any).activeAgents.set("slack.example.com#general\0*\0thread-b", fakeAgentB);

    const sendResponse = vi.fn();

    const steeredA = runner.steerOrStart(
      makeMessage({ threadId: "thread-a", content: "msg-in-a" }),
      sendResponse,
      () => false,
    );
    const steeredB = runner.steerOrStart(
      makeMessage({ threadId: "thread-b", content: "msg-in-b" }),
      sendResponse,
      () => false,
    );

    expect(steeredA).toBe(true);
    expect(steeredB).toBe(true);
    expect(steerCalls).toHaveLength(2);
    expect(steerCalls[0].key).toBe("A");
    expect(steerCalls[0].m.role).toBe("custom");
    expect(steerCalls[0].m.customType).toBe("muaddib.steered_passive");
    expect(steerCalls[0].m.content).toContain("msg-in-a");
    expect(steerCalls[1].key).toBe("B");
    expect(steerCalls[1].m.role).toBe("custom");
    expect(steerCalls[1].m.customType).toBe("muaddib.steered_passive");
    expect(steerCalls[1].m.content).toContain("msg-in-b");
  });

  it("does not steer messages from a different thread into an active proactive agent", () => {
    const runner = makeRunner();
    const steerCalls: any[] = [];
    const fakeAgent: any = { steer: (m: any) => steerCalls.push(m) };
    (runner as any).activeAgents.set("slack.example.com#general\0*\0thread-a", fakeAgent);

    const sendResponse = vi.fn();

    // Message in a different thread must not steer into thread-a's agent.
    const steeredOtherThread = runner.steerOrStart(
      makeMessage({ threadId: "thread-b", content: "other-thread" }),
      sendResponse,
      () => false,
    );
    // Message in the channel's main timeline (no thread) must not steer either.
    const steeredNoThread = runner.steerOrStart(
      makeMessage({ content: "main-timeline" }),
      sendResponse,
      () => false,
    );

    expect(steeredOtherThread).toBe(false);
    expect(steeredNoThread).toBe(false);
    expect(steerCalls).toHaveLength(0);
  });

  it("does not steer a threaded message into a proactive agent started on the main timeline", () => {
    const runner = makeRunner();
    const steerCalls: any[] = [];
    const fakeAgent: any = { steer: (m: any) => steerCalls.push(m) };
    // Agent started on the main channel timeline (no thread).
    (runner as any).activeAgents.set("slack.example.com#general\0*\0", fakeAgent);

    const sendResponse = vi.fn();
    const steered = runner.steerOrStart(
      makeMessage({ threadId: "thread-a", content: "from-thread" }),
      sendResponse,
      () => false,
    );

    expect(steered).toBe(false);
    expect(steerCalls).toHaveLength(0);
  });
});
