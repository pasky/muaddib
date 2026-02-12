import { describe, expect, it, vi } from "vitest";

import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { RoomCommandHandlerTs } from "../src/rooms/command/command-handler.js";
import type { RoomMessage } from "../src/rooms/message.js";

const roomConfig = {
  command: {
    history_size: 40,
    default_mode: "classifier:serious",
    modes: {
      serious: {
        model: "openai:gpt-4o-mini",
        prompt: "You are {mynick}. Time={current_time}.",
        reasoning_effort: "low",
        steering: true,
        triggers: {
          "!s": {},
          "!a": { reasoning_effort: "medium" },
        },
      },
      sarcastic: {
        model: "openai:gpt-4o-mini",
        prompt: "Sarcastic mode for {mynick}",
        steering: false,
        triggers: {
          "!d": {},
        },
      },
    },
    mode_classifier: {
      model: "openai:gpt-4o-mini",
      labels: {
        EASY_SERIOUS: "!s",
        SARCASTIC: "!d",
      },
      fallback_label: "EASY_SERIOUS",
    },
  },
  prompt_vars: {
    output: "",
  },
} as const;

function makeMessage(content: string): RoomMessage {
  return {
    serverTag: "libera",
    channelName: "#test",
    nick: "alice",
    mynick: "muaddib",
    content,
  };
}

function makeRunnerResult(text: string) {
  return {
    assistantMessage: {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    },
    text,
    stopReason: "stop" as const,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    resolve: resolve ?? (() => {}),
    reject: reject ?? (() => {}),
  };
}

describe("RoomCommandHandlerTs", () => {
  it("routes command to runner without duplicating trigger message and propagates reasoning level", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    await history.addMessage({
      ...makeMessage("previous context"),
      nick: "bob",
    });

    const incoming = makeMessage("!a hello there");
    await history.addMessage(incoming);

    let runnerModel: string | null = null;
    let runnerPrompt = "";
    let runnerThinkingLevel: string | undefined;
    let runnerContextContents: string[] = [];

    const handler = new RoomCommandHandlerTs({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => {
        runnerModel = input.model;
        return {
          runSingleTurn: async (prompt, options) => {
            runnerPrompt = prompt;
            runnerThinkingLevel = options?.thinkingLevel;
            runnerContextContents = (options?.contextMessages ?? []).map((entry) => entry.content);
            return {
              assistantMessage: {
                role: "assistant",
                content: [{ type: "text", text: "done" }],
                api: "openai-completions",
                provider: "openai",
                model: "gpt-4o-mini",
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
              },
              text: "done",
              stopReason: "stop",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            };
          },
        };
      },
    });

    const result = await handler.execute(incoming);

    expect(result.response).toBe("done");
    expect(result.resolved.modeKey).toBe("serious");
    expect(result.model).toBe("openai:gpt-4o-mini");
    expect(runnerModel).toBe("openai:gpt-4o-mini");
    expect(runnerPrompt).toBe("hello there");
    expect(runnerThinkingLevel).toBe("medium");
    expect(runnerContextContents.some((entry) => entry.includes("!a hello there"))).toBe(false);
    expect(runnerContextContents.some((entry) => entry.includes("previous context"))).toBe(true);

    await history.close();
  });

  it("merges debounced same-user followups into the runner prompt", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    await history.addMessage({
      ...makeMessage("previous context"),
      nick: "bob",
    });

    const incoming: RoomMessage = {
      ...makeMessage("!s first line"),
      threadId: "thread-1",
    };
    await history.addMessage(incoming);

    const recentSpy = vi.spyOn(history, "getRecentMessagesSince").mockResolvedValue([
      { message: "second line", timestamp: "2026-01-01 00:00:01" },
      { message: "third line", timestamp: "2026-01-01 00:00:02" },
    ]);

    let runnerPrompt = "";
    let runnerContextContents: string[] = [];

    const handler = new RoomCommandHandlerTs({
      roomConfig: {
        ...roomConfig,
        command: {
          ...roomConfig.command,
          debounce: 0.001,
        },
      } as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        runSingleTurn: async (prompt, options) => {
          runnerPrompt = prompt;
          runnerContextContents = (options?.contextMessages ?? []).map((entry) => entry.content);
          return {
            assistantMessage: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              api: "openai-completions",
              provider: "openai",
              model: "gpt-4o-mini",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            },
            text: "done",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
        },
      }),
    });

    const result = await handler.execute(incoming);

    expect(result.response).toBe("done");
    expect(result.resolved.queryText).toBe("first line\nsecond line\nthird line");
    expect(runnerPrompt).toBe("first line\nsecond line\nthird line");
    expect(runnerContextContents.some((entry) => entry.includes("second line"))).toBe(false);
    expect(recentSpy).toHaveBeenCalledTimes(1);
    expect(recentSpy).toHaveBeenCalledWith(
      "libera",
      "#test",
      "alice",
      expect.any(Number),
      "thread-1",
    );

    await history.close();
  });

  it("returns help text for !h", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const incoming = makeMessage("!h");
    await history.addMessage(incoming);

    const handler = new RoomCommandHandlerTs({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => {
        throw new Error("runner should not be called for help");
      },
    });

    const result = await handler.execute(incoming);

    expect(result.response).toContain("default is");
    expect(result.resolved.helpRequested).toBe(true);

    await history.close();
  });

  it("returns rate-limit warning and skips runner when limiter denies request", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const incoming = makeMessage("!s should be rate limited");
    const sent: string[] = [];

    const handler = new RoomCommandHandlerTs({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      rateLimiter: {
        checkLimit: vi.fn().mockReturnValue(false),
      },
      runnerFactory: () => {
        throw new Error("runner should not be called when rate-limited");
      },
    });

    const result = await handler.handleIncomingMessage(incoming, {
      isDirect: true,
      sendResponse: async (text) => {
        sent.push(text);
      },
    });

    expect(result?.response).toContain("rate limiting");
    expect(result?.model).toBeNull();
    expect(result?.usage).toBeNull();
    expect(sent).toEqual(["alice: Slow down a little, will you? (rate limiting)"]);

    const rows = await history.getFullHistory("libera", "#test");
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe("user");
    expect(rows[1].role).toBe("assistant");
    expect(rows[1].message).toContain("rate limiting");

    const llmCalls = await history.getLlmCalls();
    expect(llmCalls).toHaveLength(0);

    await history.close();
  });

  it("handleIncomingMessage persists user + assistant with selected trigger mode", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const incoming = makeMessage("!s persistence check");

    const handler = new RoomCommandHandlerTs({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        runSingleTurn: async () => ({
          assistantMessage: {
            role: "assistant",
            content: [{ type: "text", text: "persisted response" }],
            api: "openai-completions",
            provider: "openai",
            model: "gpt-4o-mini",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          text: "persisted response",
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      }),
    });

    await handler.handleIncomingMessage(incoming, { isDirect: true });

    const rows = await history.getFullHistory("libera", "#test");
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe("user");
    expect(rows[1].role).toBe("assistant");

    const context = await history.getContext("libera", "#test", 10);
    expect(context[1].content).toContain("!s");

    const llmCalls = await history.getLlmCalls();
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].provider).toBe("openai");
    expect(llmCalls[0].model).toBe("gpt-4o-mini");
    expect(llmCalls[0].triggerMessageId).toBeGreaterThan(0);
    expect(llmCalls[0].responseMessageId).toBeGreaterThan(0);

    await history.close();
  });

  it("collapses queued followup commands into one followup runner turn", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    let runCount = 0;
    const prompts: string[] = [];
    const runnerContextContents: string[][] = [];
    const sent: string[] = [];

    const handler = new RoomCommandHandlerTs({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        runSingleTurn: async (prompt, options) => {
          runCount += 1;
          prompts.push(prompt);
          runnerContextContents.push((options?.contextMessages ?? []).map((entry) => entry.content));

          if (runCount === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
            return makeRunnerResult("first response");
          }

          return makeRunnerResult("second response");
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(makeMessage("!s first"), {
      isDirect: true,
      sendResponse: async (text) => {
        sent.push(text);
      },
    });

    await firstStarted.promise;

    const t2 = handler.handleIncomingMessage(makeMessage("!s second"), {
      isDirect: true,
      sendResponse: async (text) => {
        sent.push(text);
      },
    });
    const t3 = handler.handleIncomingMessage(makeMessage("!s third"), {
      isDirect: true,
      sendResponse: async (text) => {
        sent.push(text);
      },
    });

    releaseFirst.resolve();

    const [result1, result2, result3] = await Promise.all([t1, t2, t3]);

    expect(runCount).toBe(2);
    expect(prompts[0]).toBe("first");
    expect(["second", "third"]).toContain(prompts[1]);

    const collapsedPrompt = prompts[1] === "second" ? "<alice> !s third" : "<alice> !s second";
    expect(runnerContextContents[1]).toContain(collapsedPrompt);
    expect(sent).toEqual(["first response", "second response"]);

    expect(result1?.response).toBe("first response");
    expect(Boolean(result2?.response) || Boolean(result3?.response)).toBe(true);
    expect([result2, result3].filter((result) => result === null)).toHaveLength(1);

    await history.close();
  });

  it("shares steering queue context across users in the same thread", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    let runCount = 0;
    const prompts: string[] = [];
    const runnerContextContents: string[][] = [];
    const sent: string[] = [];

    const handler = new RoomCommandHandlerTs({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        runSingleTurn: async (prompt, options) => {
          runCount += 1;
          prompts.push(prompt);
          runnerContextContents.push((options?.contextMessages ?? []).map((entry) => entry.content));

          if (runCount === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
            return makeRunnerResult("first response");
          }

          return makeRunnerResult("second response");
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(
      {
        ...makeMessage("!s first"),
        threadId: "thread-1",
      },
      {
        isDirect: true,
        sendResponse: async (text) => {
          sent.push(text);
        },
      },
    );

    await firstStarted.promise;

    const t2 = handler.handleIncomingMessage(
      {
        ...makeMessage("!s second"),
        nick: "bob",
        threadId: "thread-1",
      },
      {
        isDirect: true,
        sendResponse: async (text) => {
          sent.push(text);
        },
      },
    );

    const t3 = handler.handleIncomingMessage(
      {
        ...makeMessage("!s third"),
        nick: "carol",
        threadId: "thread-1",
      },
      {
        isDirect: true,
        sendResponse: async (text) => {
          sent.push(text);
        },
      },
    );

    releaseFirst.resolve();

    const [, result2, result3] = await Promise.all([t1, t2, t3]);

    expect(runCount).toBe(2);
    expect(prompts[0]).toBe("first");
    expect(["second", "third"]).toContain(prompts[1]);

    const collapsedPrompt = result2?.response ? "<carol> !s third" : "<bob> !s second";
    expect(runnerContextContents[1]).toContain(collapsedPrompt);
    expect(sent).toEqual(["first response", "second response"]);

    expect(Boolean(result2?.response) || Boolean(result3?.response)).toBe(true);
    expect([result2, result3].filter((result) => result === null)).toHaveLength(1);

    await history.close();
  });

  it("compacts passives around queued commands and keeps only the tail passive for steering", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    let runCount = 0;
    const prompts: string[] = [];
    const runnerContextContents: string[][] = [];
    const sent: string[] = [];

    const handler = new RoomCommandHandlerTs({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        runSingleTurn: async (prompt, options) => {
          runCount += 1;
          prompts.push(prompt);
          runnerContextContents.push((options?.contextMessages ?? []).map((entry) => entry.content));

          if (runCount === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
            return makeRunnerResult("first response");
          }

          return makeRunnerResult("second response");
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(makeMessage("!s first"), {
      isDirect: true,
      sendResponse: async (text) => {
        sent.push(text);
      },
    });

    await firstStarted.promise;

    const p1 = handler.handleIncomingMessage(makeMessage("p1"), {
      isDirect: false,
    });
    const p2 = handler.handleIncomingMessage(makeMessage("p2"), {
      isDirect: false,
    });
    const c2 = handler.handleIncomingMessage(makeMessage("!s second"), {
      isDirect: true,
      sendResponse: async (text) => {
        sent.push(text);
      },
    });
    const p3 = handler.handleIncomingMessage(makeMessage("p3"), {
      isDirect: false,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });

    releaseFirst.resolve();

    const [passiveResult1, passiveResult2, commandResult2, passiveResult3] = await Promise.all([
      p1,
      p2,
      c2,
      p3,
    ]);

    expect(runCount).toBe(2);
    expect(prompts).toEqual(["first", "second"]);
    expect(runnerContextContents[1].some((entry) => entry.includes("<alice> p3"))).toBe(true);
    expect(sent).toEqual(["first response", "second response"]);

    expect(passiveResult1).toBeNull();
    expect(passiveResult2).toBeNull();
    expect(commandResult2?.response).toBe("second response");
    expect(passiveResult3).toBeNull();

    await history.close();
  });
});
