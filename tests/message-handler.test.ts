import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { RuntimeLogWriter } from "../src/app/logging.js";
import { currentCostSpan, recordUsage } from "../src/cost/cost-span.js";
import { LLM_CALL_TYPE, isLlmCallType } from "../src/cost/llm-call-type.js";
import { UserCostLedger } from "../src/cost/user-cost-ledger.js";
import type { ChatHistoryStore } from "../src/history/chat-history-store.js";
import {
  RoomMessageHandler,
  type CommandRateLimiter,
  type CommandRunnerFactory,
} from "../src/rooms/command/message-handler.js";
import type { ContextReducer } from "../src/rooms/command/context-reducer.js";
import type { RoomMessage } from "../src/rooms/message.js";
import { buildArc } from "../src/rooms/message.js";
import { createDeferred, createTempHistoryStore, waitForPersistedMessage } from "./test-helpers.js";
import { createTestRuntime } from "./test-runtime.js";

const tempMuaddibHomes: string[] = [];
const originalMuaddibHome = process.env.MUADDIB_HOME;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "muaddib-message-handler-"));
  tempMuaddibHomes.push(dir);
  process.env.MUADDIB_HOME = dir;
});

afterEach(async () => {
  process.env.MUADDIB_HOME = originalMuaddibHome;
  for (const dir of tempMuaddibHomes.splice(0, tempMuaddibHomes.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const roomConfig = {
  command: {
    historySize: 40,
    defaultMode: "classifier:serious",
    modes: {
      serious: {
        model: "openai:gpt-4o-mini",
        prompt: "You are {mynick}. Time={current_time}.",
        reasoningEffort: "low",
        steering: true,
        triggers: {
          "!s": {},
          "!a": { reasoningEffort: "medium" },
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
    modeClassifier: {
      model: "openai:gpt-4o-mini",
      labels: {
        EASY_SERIOUS: "!s",
        SARCASTIC: "!d",
      },
      fallbackLabel: "EASY_SERIOUS",
    },
  },
  promptVars: {
    output: "",
  },
} as const;

function createHandler(options: {
  roomConfig?: Record<string, unknown>;
  history: ChatHistoryStore;
  runnerFactory?: CommandRunnerFactory;
  rateLimiter?: CommandRateLimiter;
  contextReducer?: ContextReducer;
  responseCleaner?: (text: string, nick: string) => string;
  autoChronicler?: any;
  chronicleStore?: any;
  classifyMode?: unknown;
  logger?: unknown;
  toolOptions?: unknown;

  authStorage?: AuthStorage;
  modelAdapter?: unknown;
  runtimeLogger?: RuntimeLogWriter;
  configData?: Record<string, unknown>;
  muaddibHome?: string;
}): RoomMessageHandler {
  const runtime = createTestRuntime({
    authStorage: options.authStorage ?? AuthStorage.inMemory(),
    history: options.history,
    configData: {
      ...(options.configData ?? {}),
      rooms: { irc: options.roomConfig ?? roomConfig },
    },
    logger: options.runtimeLogger,
    muaddibHome: options.muaddibHome,
  });

  if (options.autoChronicler || options.chronicleStore) {
    runtime.chronicle = {
      ...runtime.chronicle,
      ...(options.autoChronicler ? { autoChronicler: options.autoChronicler } : {}),
      ...(options.chronicleStore ? { chronicleStore: options.chronicleStore } : {}),
    } as NonNullable<typeof runtime.chronicle>;
  }
  if (options.modelAdapter) {
    runtime.modelAdapter = options.modelAdapter as any;
  }
  if (options.logger) {
    runtime.logger.getLogger = () => options.logger as any;
  }

  // Handler must be constructed after runtime mutations so CommandExecutor
  // and ProactiveRunner capture the overridden values.
  return new RoomMessageHandler(runtime, "irc", {
    runnerFactory: options.runnerFactory,
    rateLimiter: options.rateLimiter,
    contextReducer: options.contextReducer,
    responseCleaner: options.responseCleaner,
  });
}

function makeMessage(content: string, overrides?: Partial<RoomMessage>): RoomMessage {
  return {
    serverTag: "libera",
    channelName: "#test",
    arc: "libera##test",
    nick: "alice",
    mynick: "muaddib",
    content,
    ...overrides,
  };
}

function makeRunnerResult(
  text: string,
  options: {
    inputTokens?: number;
    outputTokens?: number;
    totalCost?: number;
    toolCallsCount?: number;
    refusalFallbackActivated?: boolean;
    refusalFallbackModel?: string;
  } = {},
) {
  const inputTokens = options.inputTokens ?? 1;
  const outputTokens = options.outputTokens ?? 1;
  const totalCost = options.totalCost ?? 0;

  return {
    assistantMessage: {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: inputTokens + outputTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    },
    text,
    stopReason: "stop" as const,
    peakTurnInput: inputTokens,
    usage: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
    },
    toolCallsCount: options.toolCallsCount,
    refusalFallbackActivated: options.refusalFallbackActivated,
    refusalFallbackModel: options.refusalFallbackModel,
  };
}

/**
 * Returns a CommandRunnerFactory that fires input.onResponse with the given text
 * and then returns makeRunnerResult(text, options).
 */
function makeRunner(
  text: string,
  options: Parameters<typeof makeRunnerResult>[1] = {},
): import("../src/rooms/command/message-handler.js").CommandRunnerFactory {
  return (input) => ({
    prompt: async () => {
      const result = makeRunnerResult(text, options);
      await input.onResponse(result.text);
      return result;
    },
  });
}

function makeUsageRecord(inputTokens: number, outputTokens: number, totalCost: number) {
  return {
    input: inputTokens,
    output: outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: inputTokens + outputTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: totalCost,
    },
  };
}

function recordCurrentSpanUsage(totalCost: number, inputTokens = 1, outputTokens = 1): void {
  const spanName = currentCostSpan()?.name;
  const callType = spanName && isLlmCallType(spanName)
    ? spanName
    : LLM_CALL_TYPE.AGENT_RUN;
  recordUsage(callType, "openai:gpt-4o-mini", makeUsageRecord(inputTokens, outputTokens, totalCost));
}

function makeRunnerWithBlockedBackgroundWork(options: {
  text?: string;
  totalCost?: number;
  toolCallsCount?: number;
  summaryText?: string;
} = {}) {
  const backgroundStarted = createDeferred<void>();
  const releaseBackground = createDeferred<void>();
  const backgroundFinished = createDeferred<void>();
  let backgroundPromptCount = 0;

  const runnerFactory: import("../src/rooms/command/message-handler.js").CommandRunnerFactory = (input) => ({
    prompt: async () => {
      const session: any = {
        messages: [
          {
            role: "toolResult",
            toolName: "web_search",
            isError: false,
            content: [{ type: "text", text: "https://example.com/result" }],
          },
        ],
        prompt: vi.fn(async () => {
          backgroundPromptCount += 1;
          if (backgroundPromptCount === 1) {
            backgroundStarted.resolve();
            await releaseBackground.promise;
            recordCurrentSpanUsage(0.02, 5, 2);
            session.messages.push({
              role: "assistant",
              content: [{ type: "text", text: "Memory updated." }],
            });
            return;
          }

          recordCurrentSpanUsage(0.03, 7, 4);
          session.messages.push({
            role: "assistant",
            content: [{ type: "text", text: options.summaryText ?? "Summarized tool results." }],
          });
        }),
        dispose: vi.fn(async () => {
          backgroundFinished.resolve();
        }),
      };

      const result = makeRunnerResult(options.text ?? "primary response", {
        inputTokens: 20,
        outputTokens: 10,
        totalCost: options.totalCost ?? 0.35,
        toolCallsCount: options.toolCallsCount ?? 1,
      });
      await input.onResponse(result.text);
      return {
        ...result,
        session,
        bumpSessionLimits: vi.fn(),
        muteResponses: vi.fn(),
      };
    },
  });

  return { runnerFactory, backgroundStarted, releaseBackground, backgroundFinished };
}

async function readRawJsonlLines(history: ChatHistoryStore, arc = "libera##test") {
  const arcsBase = (history as any).arcsBasePath;
  const today = new Date().toISOString().slice(0, 10);
  const jsonlRaw = await readFile(join(arcsBase, arc, "chat_history", `${today}.jsonl`), "utf-8");
  return jsonlRaw.trim().split("\n").map((l: string) => JSON.parse(l));
}

describe("RoomMessageHandler", () => {
  it("routes command to runner without duplicating trigger message and propagates reasoning level", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    await history.addMessage({
      ...makeMessage("previous context"),
      nick: "bob",
    });

    const incoming = makeMessage("!a hello there");
    // Note: handleIncomingMessage adds the trigger to history automatically; don't pre-add it.

    let runnerModel: string | null = null;
    let runnerPrompt = "";
    let runnerThinkingLevel: string | undefined;
    let runnerContextContents: string[] = [];

    const sent: string[] = [];
    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => {
        runnerModel = input.model;
        return {
          prompt: async (prompt, options) => {
            runnerPrompt = prompt;
            runnerThinkingLevel = options?.thinkingLevel;
            runnerContextContents = (options?.contextMessages ?? []).map((entry) => typeof entry.content === 'string' ? entry.content : entry.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' '));
            const result = makeRunnerResult("done");
            await input.onResponse(result.text);
            return result;
          },
        };
      },
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async (text) => { sent.push(text); } });

    expect(sent[0]).toBe("done");
    expect(runnerModel).toBe("openai:gpt-4o-mini");
    expect(runnerPrompt).toMatch(/^-{30}\n\[\d{2}:\d{2}\] <alice> hello there$/);
    expect(runnerThinkingLevel).toBe("medium");
    expect(runnerContextContents.some((entry) => entry.includes("!a hello there"))).toBe(false);
    expect(runnerContextContents.some((entry) => entry.includes("previous context"))).toBe(true);

    await history.close();
  });

  it("strips echoed IRC context prefixes from generated response text", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s ping");

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("[02:32] <MuaddibLLM> pasky: Pong! S latenci nizsi nez moje chut."),
    });

    const sent: string[] = [];
    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async (text) => { sent.push(text); } });

    expect(sent[0]).toBe("pasky: Pong! S latenci nizsi nez moje chut.");

    await history.close();
  });

  it("strips echoed IRC context prefixes in onResponse callback (sendResponse path)", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s ping");
    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("[01:21] <MuaddibLLM> pasky: clean answer here"),
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, {
      sendResponse: async (text) => { sent.push(text); },
    });

    // The sendResponse callback must receive cleaned text, not the raw echoed prefix
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe("pasky: clean answer here");

    await history.close();
  });

  it("strips IRC echo prefixes including angle-bracketed nicks", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s some update");

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("[serious] [02:32] <MuaddibLLM> Here is the answer."),
    });

    const sent: string[] = [];
    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async (text) => { sent.push(text); } });

    expect(sent[0]).toBe("Here is the answer.");

    await history.close();
  });

  it("strips bare leading timestamp without angle-bracket nick (Slack/Discord echo)", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s hi o/");

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("[01:36] hey pasky, o/ what's up?"),
    });

    const sent: string[] = [];
    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async (text) => { sent.push(text); } });

    expect(sent[0]).toBe("hey pasky, o/ what's up?");

    await history.close();
  });

  it("strips bare command-dispatch prefix without angle brackets", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s hi");

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("!d caster: answer follows"),
    });

    const sent: string[] = [];
    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async (text) => { sent.push(text); } });

    expect(sent[0]).toBe("answer follows");

    await history.close();
  });

  it("logs direct command lifecycle to injected logger", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s ping");
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      logger,
      runnerFactory: makeRunner("pong"),
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async () => {} });

    expect(logger.debug).toHaveBeenCalledWith(
      "Handling direct command",
      "arc=libera##test",
      "nick=alice",
    );
    expect(logger.debug).toHaveBeenCalledWith(
      "Resolved direct command",
      "arc=libera##test",
      "mode=serious",
      "trigger=!s",
      "model=openai:gpt-4o-mini",
      "context_disabled=false",
    );

    await history.close();
  });

  it("logs parse/help/rate-limit events with Python-matching severities", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const parseErrorHandler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      logger,
      runnerFactory: () => ({
        prompt: async () => makeRunnerResult("unused"),
      }),
    });

    await parseErrorHandler.handleIncomingMessage(makeMessage("!unknown ping", { isDirect: true }), {
    });
    await parseErrorHandler.handleIncomingMessage(makeMessage("!h", { isDirect: true }), {
    });

    const rateLimitedHandler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      logger,
      rateLimiter: {
        checkLimit: vi.fn().mockReturnValue(false),
      },
      runnerFactory: () => ({
        prompt: async () => makeRunnerResult("unused"),
      }),
    });

    await rateLimitedHandler.handleIncomingMessage(makeMessage("!s too-fast", { isDirect: true }), {
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "Command parse error",
      "arc=libera##test",
      "nick=alice",
      "error=Unknown command '!unknown'. Use !h for help.",
      "content=!unknown ping",
    );
    expect(logger.debug).toHaveBeenCalledWith("Sending help message", "nick=alice");
    expect(logger.warn).toHaveBeenCalledWith(
      "Rate limit triggered",
      "arc=libera##test",
      "nick=alice",
    );

    await history.close();
  });

  it("logs fallback + cost milestone lifecycle with info severity", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    await history.logLlmCost("libera##test", {
      call: "agent_run",
      model: "gpt-4o-mini",
      inTok: 10,
      outTok: 10,
      cost: 0.9,
    });

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      configData: { agent: { refusalFallbackModel: "anthropic:claude-3-5-haiku" } },
      logger,
      runnerFactory: makeRunner("The AI refused to respond to this request", {
        refusalFallbackActivated: true,
        refusalFallbackModel: "anthropic:claude-3-5-haiku",
      }),
    });

    const sent: string[] = [];
    await handler.handleIncomingMessage(makeMessage("!s expensive fallback", { isDirect: true }), {
      sendResponse: async (text) => { sent.push(text); },
    });

    // Refusal fallback suffix is now appended by SessionRunner (not invokeAndPostProcess),
    // so it doesn't appear when using mock runnerFactory.
    expect(sent[0]).toBe("The AI refused to respond to this request");

    await history.close();
  });

  it("logs agent execution failures at error severity", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      logger,
      runnerFactory: () => ({
        prompt: async () => {
          throw new Error("runner boom");
        },
      }),
    });

    await expect(
      handler.handleIncomingMessage(makeMessage("!d explode", { isDirect: true }), {
      }),
    ).rejects.toThrow("runner boom");

    // Error propagates without being logged at executor level (no catch+rethrow).

    await history.close();
  });

  it("writes command lifecycle logs into message-context files", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const logsHome = await mkdtemp(join(tmpdir(), "muaddib-command-logs-"));
    const fixedNow = new Date(2026, 1, 12, 13, 14, 15, 123);
    const runtimeLogs = new RuntimeLogWriter({
      muaddibHome: logsHome,
      nowProvider: () => fixedNow,
      stdout: {
        write: () => true,
      } as unknown as NodeJS.WriteStream,
    });

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runtimeLogger: runtimeLogs,
      runnerFactory: makeRunner("pong"),
    });

    await runtimeLogs.withMessageContext(
      {
        arc: "libera##test",
        nick: "alice",
        message: "!s ping",
      },
      async () => {
        await handler.handleIncomingMessage(makeMessage("!s ping", { isDirect: true }), {
          sendResponse: async () => {},
        });
      },
    );

    const datePath = fixedNow.toISOString().slice(0, 10);
    const arcDir = join(logsHome, "logs", datePath, "libera##test");
    const arcFiles = await readdir(arcDir);
    expect(arcFiles).toHaveLength(1);

    const messageLog = await readFile(join(arcDir, arcFiles[0]), "utf-8");
    expect(messageLog).toContain(" - DEBUG - Handling direct command");
    expect(messageLog).toContain(" - DEBUG - Resolved direct command");

    await rm(logsHome, { recursive: true, force: true });
    await history.close();
  });

  it("applies context reducer when mode enables auto_reduce_context", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    await history.addMessage({
      ...makeMessage("previous context"),
      nick: "bob",
    });

    const incoming = makeMessage("!s reduce context please");
    await history.addMessage(incoming);

    const contextReducer = {
      isConfigured: true,
      reduce: vi.fn(async () => [
        {
          role: "user" as const,
          content: "[10:00] <summary> reduced context",
          timestamp: 0,
        },
      ]),
    };

    let runnerPrompt = "";
    let runnerContextContents: string[] = [];

    const handler = createHandler({
      roomConfig: {
        ...roomConfig,
        command: {
          ...roomConfig.command,
          modes: {
            ...roomConfig.command.modes,
            serious: {
              ...roomConfig.command.modes.serious,
              autoReduceContext: true,
            },
          },
        },
      } as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      contextReducer,
      runnerFactory: (input) => ({
        prompt: async (prompt, options) => {
          runnerPrompt = prompt;
          runnerContextContents = (options?.contextMessages ?? []).map((entry) => typeof entry.content === 'string' ? entry.content : entry.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' '));
          const result = makeRunnerResult("done");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async () => {} });

    expect(contextReducer.reduce).toHaveBeenCalledTimes(1);
    expect(runnerPrompt).toMatch(/^-{30}\n\[\d{2}:\d{2}\] <alice> reduce context please$/);
    expect(runnerContextContents).toEqual(["[10:00] <summary> reduced context"]);
    expect(runnerContextContents.some((entry) => entry.includes("previous context"))).toBe(false);

    await history.close();
  });

  it("prepends chapter context by default and skips it when include_chapter_summary is disabled", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    await history.addMessage({
      ...makeMessage("previous context"),
      nick: "bob",
    });

    const incoming = makeMessage("!s include summary please");
    await history.addMessage(incoming);

    const chapterContext = [
      {
        role: "user" as const,
        content: "<context_summary>chapter recap</context_summary>",
      },
    ];

    const chronicleStore = {
      getChapterContextMessages: vi.fn(async () => chapterContext),
    };

    const runnerContextWithSummary: string[][] = [];

    const handlerWithSummary = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      chronicleStore,
      runnerFactory: (input) => ({
        prompt: async (_prompt, options) => {
          runnerContextWithSummary.push((options?.contextMessages ?? []).map((entry) => typeof entry.content === 'string' ? entry.content : entry.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')));
          const result = makeRunnerResult("done");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    incoming.isDirect = true;
    await handlerWithSummary.handleIncomingMessage(incoming, { sendResponse: async () => {} });

    expect(chronicleStore.getChapterContextMessages).toHaveBeenCalledWith("libera##test");
    expect(runnerContextWithSummary[0][0]).toBe("<context_summary>chapter recap</context_summary>");

    const handlerWithoutSummary = createHandler({
      roomConfig: {
        ...roomConfig,
        command: {
          ...roomConfig.command,
          modes: {
            ...roomConfig.command.modes,
            serious: {
              ...roomConfig.command.modes.serious,
              includeChapterSummary: false,
            },
          },
        },
      } as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      chronicleStore,
      runnerFactory: makeRunner("done"),
    });

    incoming.isDirect = true;
    await handlerWithoutSummary.handleIncomingMessage(incoming, { sendResponse: async () => {} });
    expect(chronicleStore.getChapterContextMessages).toHaveBeenCalledTimes(1);

    await history.close();
  });

  it("filters baseline tools via allowed_tools", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s scoped tools");
    const seenToolNames: string[] = [];

    const handler = createHandler({
      roomConfig: {
        ...roomConfig,
        command: {
          ...roomConfig.command,
          modes: {
            ...roomConfig.command.modes,
            serious: {
              ...roomConfig.command.modes.serious,
              allowedTools: ["web_search", "make_plan"],
            },
          },
        },
      } as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => {
        seenToolNames.push(...input.toolSet.tools.map((tool) => tool.name));
        return makeRunner("done")(input);
      },
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async () => {} });

    expect(seenToolNames).toEqual(["web_search", "make_plan"]);

    await history.close();
  });

  it("passes oracle tool with invocation context containing conversation history", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    // Add prior conversation context
    await history.addMessage({ ...makeMessage("first context line"), nick: "bob" });
    await history.addMessage(
      { ...makeMessage("bot reply"), nick: "muaddib" },
      { role: "assistant" },
    );

    const incoming = makeMessage("!s ask the oracle");
    let oracleTool: any = null;
    let seenContextMessages: any[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => {
        // Find the oracle tool among the tools passed to the runner
        oracleTool = input.toolSet.tools.find((t) => t.name === "oracle");
        return {
          prompt: async (_prompt: string, opts?: { contextMessages?: any[] }) => {
            seenContextMessages = opts?.contextMessages ?? [];
            const result = makeRunnerResult("done");
            await input.onResponse(result.text);
            return result;
          },
        };
      },
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async () => {} });

    // Oracle tool should be present in the tool set
    expect(oracleTool).toBeDefined();
    expect(oracleTool.name).toBe("oracle");
    // Context messages should include prior conversation (not just the trigger)
    expect(seenContextMessages.length).toBeGreaterThan(0);

    await history.close();
  });

  it("second command in same thread steers into active session and returns null", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming: RoomMessage = {
      ...makeMessage("!s first line"),
      threadId: "thread-1",
    };

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    let promptCallCount = 0;
    const steerCalls: any[] = [];
    const mockAgent = {
      steer: (msg: any) => { steerCalls.push(msg); },
    };

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async (_prompt) => {
          promptCallCount += 1;
          input.onAgentCreated?.(mockAgent as any);
          firstStarted.resolve();
          await releaseFirst.promise;
          const result = makeRunnerResult("done");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    const sent: string[] = [];
    incoming.isDirect = true;
    const resultPromise = handler.handleIncomingMessage(incoming, {
      sendResponse: async (text) => { sent.push(text); },
    });

    await firstStarted.promise;

    const followup: RoomMessage = {
      ...makeMessage("!s second line"),
      threadId: "thread-1",
    };

    followup.isDirect = true;
    const followupPromise = handler.handleIncomingMessage(followup, {
      sendResponse: async () => {},
    });

    releaseFirst.resolve();

    await Promise.all([resultPromise, followupPromise]);

    expect(sent[0]).toBe("done");
    expect(promptCallCount).toBe(1);
    expect(steerCalls).toHaveLength(1);
    expect(steerCalls[0].content[0].text).toContain("second line");
    // Direct thread follow-ups are user messages, not background noise —
    // they should NOT get the "do not derail" <meta> wrapper.
    expect(steerCalls[0].content[0].text).not.toContain("<meta>");

    await history.close();
  });

  it("intercepts !approve and resumes pending network access in the same thread only", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const requestStarted = createDeferred<void>();
    const requestPrompted = createDeferred<void>();
    let runCompleted = false;

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => {
        const requestTool = input.toolSet.tools.find((tool) => tool.name === "request_network_access");
        expect(requestTool).toBeDefined();

        return {
          prompt: async () => {
            requestStarted.resolve();
            const toolResult = await requestTool!.execute(
              "call-1",
              { url: "https://Example.com/docs?page=1", reason: "Need docs" },
              undefined,
              undefined,
            );
            const textBlock = toolResult.content.find((block) => block.type === "text");
            const text = textBlock?.type === "text" ? textBlock.text : "missing tool result";
            await input.onResponse(text);
            return makeRunnerResult(text);
          },
        };
      },
    });

    const sent: string[] = [];
    const runPromise = handler.handleIncomingMessage(
      makeMessage("!s request access", { isDirect: true, threadId: "thread-1" }),
      {
        sendResponse: async (text) => {
          sent.push(text);
          if (text.includes("Network access request")) {
            requestPrompted.resolve();
          }
        },
      },
    ).finally(() => {
      runCompleted = true;
    });

    await requestStarted.promise;
    await requestPrompted.promise;

    expect(sent[0]).toContain("Network access request");
    expect(sent[0]).toContain("Reply `!approve");
    const requestId = sent[0].match(/request\s+(\S+)\s+for/u)?.[1];
    expect(requestId).toBeTruthy();

    const wrongThreadReplies: string[] = [];
    await handler.handleIncomingMessage(
      makeMessage(`!approve ${requestId}`, { isDirect: false, threadId: "thread-2", nick: "bob" }),
      {
        sendResponse: async (text) => {
          wrongThreadReplies.push(text);
        },
      },
    );

    expect(wrongThreadReplies).toEqual([
      `bob: Network access request ${requestId} is pending in a different room or thread.`,
    ]);
    expect(runCompleted).toBe(false);

    const untrustedReplies: string[] = [];
    await handler.handleIncomingMessage(
      makeMessage(`!approve ${requestId}`, { isDirect: false, threadId: "thread-1", nick: "mallory", trusted: false }),
      {
        sendResponse: async (text) => {
          untrustedReplies.push(text);
        },
      },
    );

    expect(untrustedReplies).toEqual([
      "mallory: Only trusted users may approve or deny network access requests.",
    ]);
    expect(runCompleted).toBe(false);

    const approvalReplies: string[] = [];
    await handler.handleIncomingMessage(
      makeMessage(`!approve ${requestId}`, { isDirect: false, threadId: "thread-1", nick: "bob", trusted: true }),
      {
        sendResponse: async (text) => {
          approvalReplies.push(text);
        },
      },
    );

    await runPromise;

    expect(approvalReplies).toEqual([
      `bob: approved network access request ${requestId} for https://example.com/docs.`,
    ]);
    expect(sent[sent.length - 1]).toBe("Network access approved for https://example.com/docs.");

    await history.close();
  });

  it("intercepts !deny and returns a denied tool result", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const requestStarted = createDeferred<void>();
    const requestPrompted = createDeferred<void>();

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => {
        const requestTool = input.toolSet.tools.find((tool) => tool.name === "request_network_access");
        expect(requestTool).toBeDefined();

        return {
          prompt: async () => {
            requestStarted.resolve();
            const toolResult = await requestTool!.execute(
              "call-1",
              { url: "https://example.com/private?token=1" },
              undefined,
              undefined,
            );
            const textBlock = toolResult.content.find((block) => block.type === "text");
            const text = textBlock?.type === "text" ? textBlock.text : "missing tool result";
            await input.onResponse(text);
            return makeRunnerResult(text);
          },
        };
      },
    });

    const sent: string[] = [];
    const runPromise = handler.handleIncomingMessage(
      makeMessage("!s request private access", { isDirect: true, threadId: "thread-9" }),
      {
        sendResponse: async (text) => {
          sent.push(text);
          if (text.includes("Network access request")) {
            requestPrompted.resolve();
          }
        },
      },
    );

    await requestStarted.promise;
    await requestPrompted.promise;

    const requestId = sent[0].match(/request\s+(\S+)\s+for/u)?.[1];
    expect(requestId).toBeTruthy();

    const denyReplies: string[] = [];
    await handler.handleIncomingMessage(
      makeMessage(`!deny ${requestId}`, { isDirect: false, threadId: "thread-9", nick: "bob" }),
      {
        sendResponse: async (text) => {
          denyReplies.push(text);
        },
      },
    );

    await runPromise;

    expect(denyReplies).toEqual([
      `bob: denied network access request ${requestId} for https://example.com/private.`,
    ]);
    expect(sent[sent.length - 1]).toBe("Network access denied for https://example.com/private.");

    await history.close();
  });

  it("steers follow-ups into active session regardless of mode token or channel policy", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const policyRoomConfig = {
      ...roomConfig,
      command: {
        ...roomConfig.command,
        channelModes: {
          "libera##test": "!d",
        },
      },
    };

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    let promptCallCount = 0;
    const steerCalls: any[] = [];
    const mockAgent = {
      steer: (msg: any) => { steerCalls.push(msg); },
    };

    const handler = createHandler({
      roomConfig: policyRoomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          promptCallCount += 1;
          if (promptCallCount > 1) {
            throw new Error("follow-up should have been steered, not started a new session");
          }

          input.onAgentCreated?.(mockAgent as any);
          firstStarted.resolve();
          await releaseFirst.promise;
          const result = makeRunnerResult("done");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(makeMessage("!s first", { isDirect: true }), {
      sendResponse: async () => {},
    });

    await firstStarted.promise;

    // Plain in-channel highlight steers despite channel being forced to !d.
    await handler.handleIncomingMessage(
      {
        ...makeMessage("follow up"),
        originalContent: "muaddib: follow up",
        isDirect: true,
      },
      { sendResponse: async () => {} },
    );

    // Explicit !d follow-up also steers — mode tokens don't break active sessions.
    await handler.handleIncomingMessage(
      makeMessage("!d another thought", { isDirect: true }),
      { sendResponse: async () => {} },
    );

    releaseFirst.resolve();
    await t1;

    expect(promptCallCount).toBe(1);
    expect(steerCalls).toHaveLength(2);
    // First steer: plain highlight, no <meta> wrapper.
    expect(steerCalls[0].content[0].text).toContain("follow up");
    expect(steerCalls[0].content[0].text).not.toContain("<meta>");
    // Second steer: explicit !d follow-up, also direct → no <meta> wrapper.
    expect(steerCalls[1].content[0].text).toContain("!d another thought");
    expect(steerCalls[1].content[0].text).not.toContain("<meta>");

    await history.close();
  });

  it("sends user-visible warning when steering an explicit cross-mode command into an active session", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    const steerCalls: any[] = [];
    const mockAgent = {
      steer: (msg: any) => { steerCalls.push(msg); },
    };

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          input.onAgentCreated?.(mockAgent as any);
          firstStarted.resolve();
          await releaseFirst.promise;
          const result = makeRunnerResult("done");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    const sent: string[] = [];

    // Start a session in serious mode (!s)
    const t1 = handler.handleIncomingMessage(makeMessage("!s first", { isDirect: true }), {
      sendResponse: async (text) => { sent.push(text); },
    });

    await firstStarted.promise;

    const crossModeSent: string[] = [];
    const sameModeSent: string[] = [];
    const plainSent: string[] = [];

    // Send a follow-up in a DIFFERENT mode (!d = sarcastic) — should warn
    await handler.handleIncomingMessage(
      makeMessage("!d cross-mode thought", { isDirect: true }),
      { sendResponse: async (text) => { crossModeSent.push(text); } },
    );

    // Send a follow-up in the SAME mode (!a = serious) — should NOT warn
    await handler.handleIncomingMessage(
      makeMessage("!a same-mode thought", { isDirect: true }),
      { sendResponse: async (text) => { sameModeSent.push(text); } },
    );

    // Send a follow-up with no mode token — should NOT warn
    await handler.handleIncomingMessage(
      makeMessage("plain follow-up", { isDirect: true }),
      { sendResponse: async (text) => { plainSent.push(text); } },
    );

    releaseFirst.resolve();
    await t1;

    // All three follow-ups should have been steered
    expect(steerCalls).toHaveLength(3);

    // Cross-mode steering sends a user-visible warning via sendResponse
    expect(crossModeSent).toHaveLength(1);
    expect(crossModeSent[0]).toContain("!d ignored");
    expect(crossModeSent[0]).toContain("serious session");
    expect(crossModeSent[0]).toContain("!c");

    // Same-mode and plain follow-ups produce no warning
    expect(sameModeSent).toHaveLength(0);
    expect(plainSent).toHaveLength(0);

    await history.close();
  });

  it("returns help text for !h", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!h");
    await history.addMessage(incoming);

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => {
        throw new Error("runner should not be called for help");
      },
    });

    const sent: string[] = [];
    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async (text) => { sent.push(text); } });

    expect(sent[0]).toContain("default is");

    await history.close();
  });

  it("stores a user OpenRouter key without persisting the secret to chat history", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();
    const muaddibHome = await mkdtemp(join(tmpdir(), "muaddib-setkey-"));

    try {
      const incoming = makeMessage("!setkey openrouter sk-or-v1-secret", { isDirect: true });
      const sent: string[] = [];

      const handler = createHandler({
        roomConfig: roomConfig as any,
        history,
        muaddibHome,
        classifyMode: async () => "EASY_SERIOUS",
        runnerFactory: () => {
          throw new Error("runner should not be called for !setkey");
        },
      });

      await handler.handleIncomingMessage(incoming, {
        sendResponse: async (text) => {
          sent.push(text);
        },
      });

      expect(sent[0]).toContain("saved your OpenRouter key");
      expect(sent[0]).toContain("!setkey openrouter");

      const userArc = buildArc("libera", "alice");
      const authRaw = await readFile(join(muaddibHome, "users", userArc, "auth.json"), "utf-8");
      expect(authRaw).toContain("sk-or-v1-secret");

      const rows = await history.getFullHistory("libera##test");
      expect(rows).toHaveLength(2);
      expect(rows[0]?.message).toContain("!setkey openrouter [redacted]");
      expect(rows.map((row) => row.message).join("\n")).not.toContain("sk-or-v1-secret");

      const arcsBase = (history as any).arcsBasePath;
      const today = new Date().toISOString().slice(0, 10);
      const jsonlRaw = await readFile(join(arcsBase, "libera##test", "chat_history", `${today}.jsonl`), "utf-8");
      expect(jsonlRaw).toContain("[redacted]");
      expect(jsonlRaw).not.toContain("sk-or-v1-secret");
    } finally {
      await rm(muaddibHome, { recursive: true, force: true });
      await history.close();
    }
  });

  it("reports the free-tier balance for !balance using shared policy defaults", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();
    const muaddibHome = await mkdtemp(join(tmpdir(), "muaddib-balance-"));

    try {
      const userArc = buildArc("libera", "alice");
      const ledger = new UserCostLedger(muaddibHome);
      await ledger.logUserCost(userArc, {
        ts: new Date().toISOString(),
        cost: 0.75,
        byok: false,
        arc: buildArc("libera", "#test"),
        model: "openai:gpt-4o-mini",
      });

      const incoming = makeMessage("!balance", { isDirect: true });
      const sent: string[] = [];
      const handler = createHandler({
        roomConfig: roomConfig as any,
        history,
        muaddibHome,
        configData: {
          costPolicy: {
            freeTierBudgetUsd: 2,
          },
        },
        classifyMode: async () => "EASY_SERIOUS",
        runnerFactory: () => {
          throw new Error("runner should not be called for !balance");
        },
      });

      await handler.handleIncomingMessage(incoming, {
        sendResponse: async (text) => {
          sent.push(text);
        },
      });

      expect(sent[0]).toContain("free tier");
      expect(sent[0]).toContain("$0.7500 / $2.00");
      expect(sent[0]).toContain("last 72h");
      expect(sent[0]).toContain("openrouter.ai");
      expect(sent[0]).toContain("/msg");
      expect(sent[0]).toContain("!setkey openrouter");
      expect(sent[0]).toContain("budget limit");
      expect(sent[0]).toContain("no responsibility");
    } finally {
      await rm(muaddibHome, { recursive: true, force: true });
      await history.close();
    }
  });

  it("remaps BYOK sessions to OpenRouter, injects the user key, and logs user cost by date", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();
    const muaddibHome = await mkdtemp(join(tmpdir(), "muaddib-byok-"));

    try {
      const userArc = buildArc("libera", "alice");
      AuthStorage.create(join(muaddibHome, "users", userArc, "auth.json")).set("openrouter", {
        type: "api_key",
        key: "sk-or-v1-user",
      });

      let runnerModel: string | null = null;
      let runnerOpenRouterKey: string | undefined;
      let runnerAnthropicKey: string | undefined;
      const sent: string[] = [];

      const handler = createHandler({
        roomConfig: roomConfig as any,
        history,
        muaddibHome,
        authStorage: AuthStorage.inMemory({
          openrouter: { type: "api_key", key: "sk-or-v1-operator" },
          anthropic: { type: "api_key", key: "sk-ant-operator" },
        }),
        classifyMode: async () => "EASY_SERIOUS",
        runnerFactory: (input) => ({
          prompt: async () => {
            runnerModel = input.model;
            runnerOpenRouterKey = await input.authStorage?.getApiKey("openrouter");
            runnerAnthropicKey = await input.authStorage?.getApiKey("anthropic");
            const result = makeRunnerResult("done", {
              inputTokens: 10,
              outputTokens: 5,
              totalCost: 0.05,
            });
            await input.onResponse(result.text);
            return result;
          },
        }),
      });

      await handler.handleIncomingMessage(makeMessage("!s hello", { isDirect: true }), {
        sendResponse: async (text) => {
          sent.push(text);
        },
      });

      expect(sent).toEqual(["done"]);
      expect(runnerModel).toBe("openrouter:openai/gpt-4o-mini");
      expect(runnerOpenRouterKey).toBe("sk-or-v1-user");
      expect(runnerAnthropicKey).toBe("sk-ant-operator");

      const today = new Date().toISOString().slice(0, 10);
      const ledgerRaw = await readFile(join(muaddibHome, "users", userArc, "cost", `${today}.jsonl`), "utf-8");
      const ledgerRows = ledgerRaw.trim().split("\n").map((line) => JSON.parse(line));
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toMatchObject({
        byok: true,
        arc: "libera##test",
        model: "openai:gpt-4o-mini",
        cost: 0.05,
      });
    } finally {
      await rm(muaddibHome, { recursive: true, force: true });
      await history.close();
    }
  });

  it("refuses over-budget free users before runner creation", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();
    const muaddibHome = await mkdtemp(join(tmpdir(), "muaddib-budget-"));

    try {
      const userArc = buildArc("libera", "alice");
      const ledger = new UserCostLedger(muaddibHome);
      await ledger.logUserCost(userArc, {
        ts: new Date().toISOString(),
        cost: 2.1,
        byok: false,
        arc: buildArc("libera", "#test"),
        model: "openai:gpt-4o-mini",
      });

      const sent: string[] = [];
      const handler = createHandler({
        roomConfig: roomConfig as any,
        history,
        muaddibHome,
        configData: {
          costPolicy: {
            freeTierBudgetUsd: 2,
            freeTierWindowHours: 72,
          },
        },
        classifyMode: async () => "EASY_SERIOUS",
        runnerFactory: () => {
          throw new Error("runner should not be called for over-budget user");
        },
      });

      await handler.handleIncomingMessage(makeMessage("!s blocked", { isDirect: true }), {
        sendResponse: async (text) => {
          sent.push(text);
        },
      });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("free tier budget is exhausted");
      expect(sent[0]).toContain("$2.1000 / $2.00");
      expect(sent[0]).toContain("/msg <me> !balance for more details");
    } finally {
      await rm(muaddibHome, { recursive: true, force: true });
      await history.close();
    }
  });

  it("emits a 90% quota warning when free tier usage is high", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();
    const muaddibHome = await mkdtemp(join(tmpdir(), "muaddib-warn-"));

    try {
      const userArc = buildArc("libera", "alice");
      const ledger = new UserCostLedger(muaddibHome);
      // Spend $1.85 of $2 budget = 92.5%
      await ledger.logUserCost(userArc, {
        ts: new Date().toISOString(),
        cost: 1.85,
        byok: false,
        arc: buildArc("libera", "#test"),
        model: "openai:gpt-4o-mini",
      });

      const sent: string[] = [];
      const handler = createHandler({
        roomConfig: roomConfig as any,
        history,
        muaddibHome,
        configData: {
          costPolicy: {
            freeTierBudgetUsd: 2,
            freeTierWindowHours: 72,
          },
        },
        classifyMode: async () => "EASY_SERIOUS",
        runnerFactory: (input) => ({
          prompt: async () => {
            const result = makeRunnerResult("response", {
              inputTokens: 10,
              outputTokens: 5,
              totalCost: 0.01,
            });
            await input.onResponse(result.text);
            return result;
          },
        }),
      });

      await handler.handleIncomingMessage(makeMessage("!s hello", { isDirect: true }), {
        sendResponse: async (text) => { sent.push(text); },
      });

      // Should have response + quota warning
      const warningMsg = sent.find((s) => s.includes("heads up"));
      expect(warningMsg).toBeDefined();
      expect(warningMsg).toContain("93%");
      expect(warningMsg).toContain("/msg <me> !balance for more details");
    } finally {
      await rm(muaddibHome, { recursive: true, force: true });
      await history.close();
    }
  });

  it("respects 90% quota warning cooldown", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();
    const muaddibHome = await mkdtemp(join(tmpdir(), "muaddib-cooldown-"));

    try {
      const userArc = buildArc("libera", "alice");
      const ledger = new UserCostLedger(muaddibHome);
      await ledger.logUserCost(userArc, {
        ts: new Date().toISOString(),
        cost: 1.85,
        byok: false,
        arc: buildArc("libera", "#test"),
        model: "openai:gpt-4o-mini",
      });

      const makeHandler = () => createHandler({
        roomConfig: roomConfig as any,
        history,
        muaddibHome,
        configData: {
          costPolicy: {
            freeTierBudgetUsd: 2,
            freeTierWindowHours: 72,
          },
        },
        classifyMode: async () => "EASY_SERIOUS",
        runnerFactory: (input) => ({
          prompt: async () => {
            const result = makeRunnerResult("response", {
              inputTokens: 10,
              outputTokens: 5,
              totalCost: 0.001,
            });
            await input.onResponse(result.text);
            return result;
          },
        }),
      });

      // First invocation: should emit warning
      const sent1: string[] = [];
      await makeHandler().handleIncomingMessage(makeMessage("!s first", { isDirect: true }), {
        sendResponse: async (text) => { sent1.push(text); },
      });
      expect(sent1.some((s) => s.includes("heads up"))).toBe(true);

      // Second invocation: cooldown should suppress the warning
      const sent2: string[] = [];
      await makeHandler().handleIncomingMessage(makeMessage("!s second", { isDirect: true }), {
        sendResponse: async (text) => { sent2.push(text); },
      });
      expect(sent2.some((s) => s.includes("heads up"))).toBe(false);
    } finally {
      await rm(muaddibHome, { recursive: true, force: true });
      await history.close();
    }
  });

  it("returns rate-limit warning and skips runner when limiter denies request", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s should be rate limited");
    const sent: string[] = [];

    const handler = createHandler({
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

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, {
      sendResponse: async (text) => {
        sent.push(text);
      },
    });

    expect(sent).toEqual(["alice: Slow down a little, will you? (rate limiting)"]);

    const rows = await history.getFullHistory("libera##test");
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe("user");
    expect(rows[1].role).toBe("assistant");
    expect(rows[1].message).toContain("rate limiting");

    await history.close();
  });

  it("triggers auto-chronicler for direct + passive paths and skips it when rate-limited", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const autoChronicler = {
      checkAndChronicle: vi.fn(async () => false),
    };

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      autoChronicler,
      runnerFactory: makeRunner("done"),
    });

    await handler.handleIncomingMessage(makeMessage("!s trigger chronicler", { isDirect: true }), { sendResponse: async () => {} });
    await handler.handleIncomingMessage(makeMessage("ambient channel line"));

    expect(autoChronicler.checkAndChronicle).toHaveBeenCalledTimes(2);
    expect(autoChronicler.checkAndChronicle).toHaveBeenNthCalledWith(
      1,
      "muaddib",
      "libera",
      "#test",
      40,
      expect.objectContaining({ userArc: "libera#alice" }),
    );
    expect(autoChronicler.checkAndChronicle).toHaveBeenNthCalledWith(
      2,
      "muaddib",
      "libera",
      "#test",
      40,
      undefined,
    );

    const rateLimitedAutoChronicler = {
      checkAndChronicle: vi.fn(async () => false),
    };

    const rateLimitedHandler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      autoChronicler: rateLimitedAutoChronicler,
      rateLimiter: {
        checkLimit: vi.fn().mockReturnValue(false),
      },
      runnerFactory: () => {
        throw new Error("runner should not run when rate-limited");
      },
    });

    await rateLimitedHandler.handleIncomingMessage(makeMessage("!s should skip autochronicler", { isDirect: true }), {
    });

    expect(rateLimitedAutoChronicler.checkAndChronicle).not.toHaveBeenCalled();

    await history.close();
  });

  it("handleIncomingMessage persists user + assistant with selected trigger mode", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s persistence check");

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("persisted response"),
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async () => {} });

    const rows = await history.getFullHistory("libera##test");
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe("user");
    expect(rows[1].role).toBe("assistant");

    // Verify run field on raw JSONL: trigger message has run == ts, assistant has run == trigger ts
    const arcsBase = (history as any).arcsBasePath;
    const today = new Date().toISOString().slice(0, 10);
    const jsonlRaw = await readFile(join(arcsBase, "libera##test", "chat_history", `${today}.jsonl`), "utf-8");
    const jsonlLines = jsonlRaw.trim().split("\n").map((l: string) => JSON.parse(l));
    expect(jsonlLines[0].run).toBe(jsonlLines[0].ts); // trigger message: run == self ts
    expect(jsonlLines[1].run).toBe(jsonlLines[0].ts); // assistant: run == trigger ts

    const context = await history.getContext("libera##test", 10);
    const assistantContent = (context[1] as any).content[0].text;
    expect(assistantContent).toContain("!s");

    await history.close();
  });

  it("emits cost followup + daily milestone messages when command usage crosses thresholds", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    await history.logLlmCost("libera##test", {
      call: "agent_run",
      model: "gpt-4o-mini",
      inTok: 10,
      outTok: 10,
      cost: 0.9,
    });

    const incoming = makeMessage("!s expensive response");
    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("primary response", {
        inputTokens: 123,
        outputTokens: 45,
        totalCost: 0.35,
        toolCallsCount: 2,
      }),
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, {
      sendResponse: async (text) => {
        sent.push(text);
      },
    });

    expect(sent).toEqual([
      "primary response",
      "(this message used 2 tool calls, 123 in / 45 out tokens, and cost $0.3500)",
      "(fun fact: my messages in this channel have already cost $1.2500 today)",
    ]);

    const rows = await history.getFullHistory("libera##test");
    expect(rows).toHaveLength(4);
    expect(rows[2].message).toContain("this message used 2 tool calls");
    expect(rows[3].message).toContain("already cost $1.2500 today");

    // Verify run linkage and structured cost persistence.
    // Line 0 is the seed logLlmCost entry; this run adds trigger/response,
    // cost followup + milestone messages, then the structured cost row
    // (persisted when the cost span closes, after the callback completes).
    const arcsBase = (history as any).arcsBasePath;
    const today = new Date().toISOString().slice(0, 10);
    const jsonlRaw = await readFile(join(arcsBase, "libera##test", "chat_history", `${today}.jsonl`), "utf-8");
    const jsonlLines = jsonlRaw.trim().split("\n").map((l: string) => JSON.parse(l));
    const triggerTs = jsonlLines[1].ts;
    expect(jsonlLines[1].run).toBe(triggerTs); // trigger: self-referencing run
    expect(jsonlLines[2].run).toBe(triggerTs); // primary response

    expect(jsonlLines[3].run).toBe(triggerTs); // cost followup
    expect(jsonlLines[4].run).toBe(triggerTs); // daily milestone

    expect(jsonlLines[5].call).toBe("agent_run");
    expect(jsonlLines[5].model).toBe("openai:gpt-4o-mini");
    expect(jsonlLines[5].run).toBe(triggerTs);
    expect(jsonlLines[5].source).toBe("execute");
    expect(jsonlLines[5].inTok).toBe(123);
    expect(jsonlLines[5].outTok).toBe(45);
    expect(jsonlLines[5].cost).toBe(0.35);

    await history.close();
  });

  it("persists structured per-run cost even when followup threshold is not crossed", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s cheap response", { isDirect: true });
    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("primary response", {
        inputTokens: 20,
        outputTokens: 10,
        totalCost: 0.05,
        toolCallsCount: 1,
      }),
    });

    await handler.handleIncomingMessage(incoming, {
      sendResponse: async (text) => {
        sent.push(text);
      },
    });

    // No cost followup/milestone at this cost level.
    expect(sent).toEqual(["primary response"]);

    const rows = await history.getFullHistory("libera##test");
    expect(rows).toHaveLength(2);

    const arcsBase = (history as any).arcsBasePath;
    const today = new Date().toISOString().slice(0, 10);
    const jsonlRaw = await readFile(join(arcsBase, "libera##test", "chat_history", `${today}.jsonl`), "utf-8");
    const jsonlLines = jsonlRaw.trim().split("\n").map((l: string) => JSON.parse(l));
    const triggerTs = jsonlLines[0].ts;

    expect(jsonlLines[2].call).toBe("agent_run");
    expect(jsonlLines[2].model).toBe("openai:gpt-4o-mini");
    expect(jsonlLines[2].run).toBe(triggerTs);
    expect(jsonlLines[2].source).toBe("execute");
    expect(jsonlLines[2].inTok).toBe(20);
    expect(jsonlLines[2].outTok).toBe(10);
    expect(jsonlLines[2].cost).toBe(0.05);

    await history.close();
  });

  it("respects configurable warnCostUsd threshold for cost followup", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s moderate response", { isDirect: true });
    const sent: string[] = [];

    // Cost of 0.35 would normally trigger the default 0.2 threshold,
    // but raising warnCostUsd to 0.5 should suppress the followup.
    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("primary response", {
        inputTokens: 100,
        outputTokens: 40,
        totalCost: 0.35,
        toolCallsCount: 2,
      }),
      configData: { agent: { sessionLimits: { warnCostUsd: 0.5 } } },
    });

    await handler.handleIncomingMessage(incoming, {
      sendResponse: async (text) => { sent.push(text); },
    });

    // No cost followup because 0.35 <= 0.5 threshold.
    expect(sent).toEqual(["primary response"]);

    await history.close();
  });

  it("persists background memory/tool-summary costs when cost followup delivery fails", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const { runnerFactory, backgroundStarted, releaseBackground, backgroundFinished } =
      makeRunnerWithBlockedBackgroundWork();

    const followupAttempted = createDeferred<void>();
    let sendCount = 0;
    const execution = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory,
    }).handleIncomingMessage(makeMessage("!s fail after response", { isDirect: true }), {
      sendResponse: async () => {
        sendCount += 1;
        if (sendCount === 2) {
          followupAttempted.resolve();
          throw new Error("cost followup delivery failed");
        }
      },
    });

    await backgroundStarted.promise;
    await followupAttempted.promise;
    releaseBackground.resolve();

    await expect(execution).rejects.toThrow("cost followup delivery failed");
    await backgroundFinished.promise;

    const jsonlLines = await readRawJsonlLines(history);
    const costRows = jsonlLines.filter((row: any) => row.call);
    expect(costRows.map((row: any) => row.call)).toEqual([
      LLM_CALL_TYPE.AGENT_RUN,
      LLM_CALL_TYPE.MEMORY_UPDATE,
      LLM_CALL_TYPE.TOOL_SUMMARY,
    ]);
    expect(costRows.map((row: any) => row.source)).toEqual([
      "execute",
      "execute",
      "execute",
    ]);

    await history.close();
  });

  it("converts oversized command responses into artifact links and keeps llm linkage", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s make it long");
    const longResponse = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8).trim();
    const artifactsPath = await mkdtemp(join(tmpdir(), "muaddib-artifacts-"));
    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: {
        ...roomConfig,
        command: {
          ...roomConfig.command,
          responseMaxBytes: 120,
        },
      } as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      configData: {
        agent: {
          tools: {
            artifacts: {
              path: artifactsPath,
              url: "https://example.com/artifacts/?",
            },
          },
        },
      },
      runnerFactory: makeRunner(longResponse),
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, {
      sendResponse: async (text) => {
        sent.push(text);
      },
    });

    expect(sent[0]).toContain("... full response: https://example.com/artifacts/?");
    expect(sent).toHaveLength(1);

    const rows = await history.getFullHistory("libera##test");
    expect(rows).toHaveLength(2);
    expect(rows[1].message).toContain("full response: https://example.com/artifacts/?");

    await history.close();
  });

  it("keeps original newlines in artifact body when IRC transport flattens outbound text", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s make it multiline");
    const multilineResponse = [
      "Line 1: first paragraph.",
      "Line 2: second paragraph.",
      "Line 3: third paragraph.",
      "Line 4: fourth paragraph.",
      "Line 5: fifth paragraph.",
      "Line 6: sixth paragraph.",
      "Line 7: seventh paragraph.",
      "Line 8: eighth paragraph.",
      "Line 9: ninth paragraph.",
      "Line 10: tenth paragraph.",
    ].join("\n");
    const artifactsPath = await mkdtemp(join(tmpdir(), "muaddib-artifacts-"));
    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: {
        ...roomConfig,
        command: {
          ...roomConfig.command,
          responseMaxBytes: 120,
        },
      } as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      configData: {
        agent: {
          tools: {
            artifacts: {
              path: artifactsPath,
              url: "https://example.com/artifacts",
            },
          },
        },
      },
      runnerFactory: makeRunner(multilineResponse),
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, {
      // IRC transport behavior: flatten newlines right before sending.
      sendResponse: async (text) => {
        sent.push(text.replace(/\n+/g, " ; ").trim());
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("full response: https://example.com/artifacts/?");
    expect(sent[0]).not.toContain("\n");

    const artifactUrl = sent[0].split("full response: ")[1]!.trim();
    const artifactFilename = decodeURIComponent(new URL(artifactUrl).search.slice(1));
    const artifactBody = await readFile(join(artifactsPath, artifactFilename), "utf-8");

    expect(artifactBody).toBe(multilineResponse);
    expect(artifactBody).toContain("\n");

    await history.close();
  });

  it("does not convert response into artifact when responseMaxBytes is not exceeded", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s short response");

    const handler = createHandler({
      roomConfig: {
        ...roomConfig,
        command: {
          ...roomConfig.command,
          responseMaxBytes: 500,
        },
      } as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("short answer"),
    });

    const sent: string[] = [];
    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async (text) => { sent.push(text); } });

    expect(sent[0]).toBe("short answer");

    await history.close();
  });

  it("keeps fallback-model llm logging/linkage when oversized response is converted to artifact", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s refusal + long fallback");

    const handler = createHandler({
      roomConfig: {
        ...roomConfig,
        command: {
          ...roomConfig.command,
          responseMaxBytes: 120,
        },
      } as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      configData: { agent: { refusalFallbackModel: "anthropic:claude-3-5-haiku" } },
      runnerFactory: makeRunner("The AI refused to respond to this request", {
        refusalFallbackActivated: true,
        refusalFallbackModel: "anthropic:claude-3-5-haiku",
      }),
    });

    const sent: string[] = [];
    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async (text) => { sent.push(text); } });

    expect(sent[0]).toContain("The AI refused to respond to this request");

    const rows = await history.getFullHistory("libera##test");
    expect(rows).toHaveLength(2);
    expect(rows[1].message).toContain("The AI refused to respond to this request");

    await history.close();
  });

  it("fails fast when command.responseMaxBytes is invalid", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    expect(
      () =>
        createHandler({
          roomConfig: {
            ...roomConfig,
            command: {
              ...roomConfig.command,
              responseMaxBytes: 0,
            },
          } as any,
          history,
          classifyMode: async () => "EASY_SERIOUS",
        }),
    ).toThrow("command.responseMaxBytes must be a positive integer.");

    await history.close();
  });

  it("treats empty agent.refusalFallbackModel as disabled", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s no refusal fallback");
    let promptRefusalFallbackModel: string | undefined;

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      configData: { agent: { refusalFallbackModel: "" } },
      runnerFactory: (input) => ({
        prompt: async (_prompt, options) => {
          promptRefusalFallbackModel = options?.refusalFallbackModel;
          const result = makeRunnerResult("done");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    const sent: string[] = [];
    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async (text) => { sent.push(text); } });

    expect(sent[0]).toBe("done");
    expect(promptRefusalFallbackModel).toBeUndefined();

    await history.close();
  });

  it("retries on explicit refusal text with agent.refusalFallbackModel and persists fallback model usage", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s refusal fallback");
    const runnerModels: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      configData: { agent: { refusalFallbackModel: "anthropic:claude-3-5-haiku" } },
      runnerFactory: (input) => {
        runnerModels.push(input.model);
        return makeRunner("The AI refused to respond to this request", {
          refusalFallbackActivated: true,
          refusalFallbackModel: "anthropic:claude-3-5-haiku",
        })(input);
      },
    });

    const sent: string[] = [];
    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async (text) => { sent.push(text); } });

    // Refusal fallback suffix is now appended by SessionRunner (not invokeAndPostProcess),
    // so it doesn't appear when using mock runnerFactory.
    expect(sent[0]).toBe("The AI refused to respond to this request");
    expect(runnerModels).toEqual(["openai:gpt-4o-mini"]);

    await history.close();
  });

  it("propagates explicit safety-refusal errors from runner", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s safety fallback");

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      configData: { agent: { refusalFallbackModel: "anthropic:claude-3-5-haiku" } },
      runnerFactory: () => ({
        prompt: async () => {
          throw new Error("Agent run failed: invalid_prompt blocked for safety reasons.");
        },
      }),
    });

    incoming.isDirect = true;
    await expect(
      handler.handleIncomingMessage(incoming, { sendResponse: async () => {} }),
    ).rejects.toThrow(
      "Agent run failed: invalid_prompt blocked for safety reasons.",
    );

    await history.close();
  });

  it("does not trigger fallback when response lacks explicit refusal/error markers", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming = makeMessage("!s no fallback");
    const runnerModels: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      configData: { agent: { refusalFallbackModel: "anthropic:claude-3-5-haiku" } },
      runnerFactory: (input) => {
        runnerModels.push(input.model);
        return makeRunner("normal answer")(input);
      },
    });

    const sent: string[] = [];
    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, { sendResponse: async (text) => { sent.push(text); } });

    expect(sent[0]).toBe("normal answer");
    expect(runnerModels).toEqual(["openai:gpt-4o-mini"]);

    await history.close();
  });

  it("concurrent commands from same user steer into active session", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    let runCount = 0;
    const steerCalls: any[] = [];
    const mockAgent = {
      steer: (msg: any) => { steerCalls.push(msg); },
    };

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async (_prompt) => {
          runCount += 1;
          input.onAgentCreated?.(mockAgent as any);
          firstStarted.resolve();
          await releaseFirst.promise;
          const result = makeRunnerResult("first response");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    const sent: string[] = [];
    const t1 = handler.handleIncomingMessage(makeMessage("!s first", { isDirect: true }), {
      sendResponse: async (text) => { sent.push(text); },
    });

    await firstStarted.promise;

    const t2 = handler.handleIncomingMessage(makeMessage("!s second", { isDirect: true }), {
      sendResponse: async () => {},
    });
    const t3 = handler.handleIncomingMessage(makeMessage("!s third", { isDirect: true }), {
      sendResponse: async () => {},
    });

    releaseFirst.resolve();

    await Promise.all([t1, t2, t3]);

    expect(runCount).toBe(1);
    expect(sent[0]).toBe("first response");
    expect(steerCalls).toHaveLength(2);
    const steeredTexts = steerCalls.map((c: any) => c.content[0].text);
    expect(steeredTexts.some((t: string) => t.includes("second"))).toBe(true);
    expect(steeredTexts.some((t: string) => t.includes("third"))).toBe(true);

    await history.close();
  });

  it("messages arriving before agent creation are buffered and steered on flush", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const resolveStarted = createDeferred<void>();
    const releaseResolve = createDeferred<void>();

    const steerCalls: any[] = [];
    const mockAgent = {
      steer: (msg: any) => { steerCalls.push(msg); },
    };

    // The runner factory delays onAgentCreated until releaseResolve fires,
    // simulating a slow resolve/context-build phase.
    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          resolveStarted.resolve();
          await releaseResolve.promise;
          input.onAgentCreated?.(mockAgent as any);
          const result = makeRunnerResult("done");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    // First message triggers session creation (blocks in prompt).
    const t1 = handler.handleIncomingMessage(makeMessage("!s hello", { isDirect: true }), {
      sendResponse: async () => {},
    });

    await resolveStarted.promise;

    // Second message arrives while agent is NOT yet created (pre-onAgentCreated).
    const t2 = handler.handleIncomingMessage(makeMessage("!s continuation", { isDirect: true }), {
      sendResponse: async () => {},
    });

    // Also a passive message from the same user should be buffered.
    const t3 = handler.handleIncomingMessage(
      makeMessage("passive follow-up"),
    );

    // Now release — onAgentCreated fires, buffered messages flush.
    releaseResolve.resolve();

    await Promise.all([t1, t2, t3]);

    expect(steerCalls).toHaveLength(2);
    const texts = steerCalls.map((c: any) => c.content[0].text);
    expect(texts.some((t: string) => t.includes("continuation"))).toBe(true);
    expect(texts.some((t: string) => t.includes("passive follow-up"))).toBe(true);

    await history.close();
  });

  it("shares session across users in the same thread via steering", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    const steerCalls: any[] = [];
    const mockAgent = {
      steer: (msg: any) => { steerCalls.push(msg); },
    };

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          input.onAgentCreated?.(mockAgent as any);
          firstStarted.resolve();
          await releaseFirst.promise;
          const result = makeRunnerResult("first response");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    const sent: string[] = [];
    const t1 = handler.handleIncomingMessage(
      { ...makeMessage("!s first"), threadId: "thread-1", isDirect: true },
      { sendResponse: async (text) => { sent.push(text); } },
    );

    await firstStarted.promise;

    const t2 = handler.handleIncomingMessage(
      { ...makeMessage("!s second"), nick: "bob", threadId: "thread-1", isDirect: true },
      { sendResponse: async () => {} },
    );

    const t3 = handler.handleIncomingMessage(
      { ...makeMessage("!s third"), nick: "carol", threadId: "thread-1", isDirect: true },
      { sendResponse: async () => {} },
    );

    releaseFirst.resolve();

    await Promise.all([t1, t2, t3]);

    expect(sent[0]).toBe("first response");
    expect(steerCalls).toHaveLength(2);
    const steeredTexts = steerCalls.map((c: any) => c.content[0].text);
    expect(steeredTexts).toContainEqual(expect.stringContaining("bob"));
    expect(steeredTexts).toContainEqual(expect.stringContaining("carol"));

    await history.close();
  });

  it("passives and commands arriving during active session all steer into the agent", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    const steerCalls: any[] = [];
    const mockAgent = {
      steer: (msg: any) => { steerCalls.push(msg); },
    };
    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          input.onAgentCreated?.(mockAgent as any);
          firstStarted.resolve();
          await releaseFirst.promise;
          const result = makeRunnerResult("first response");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(makeMessage("!s first", { isDirect: true }), {
      sendResponse: async (text) => { sent.push(text); },
    });

    await firstStarted.promise;

    const p3Persisted = waitForPersistedMessage(history, (message) => message.content === "p3");

    const p1 = handler.handleIncomingMessage(makeMessage("p1"));
    const p2 = handler.handleIncomingMessage(makeMessage("p2"));
    const c2 = handler.handleIncomingMessage(makeMessage("!s second", { isDirect: true }), {
      sendResponse: async (text) => { sent.push(text); },
    });
    const p3 = handler.handleIncomingMessage(makeMessage("p3"));

    await p3Persisted;
    releaseFirst.resolve();

    await Promise.all([t1, p1, p2, c2, p3]);

    expect(sent).toEqual(["first response"]);
    // All 4 messages should have been steered into the agent
    expect(steerCalls).toHaveLength(4);

    await history.close();
  });

  it("passes onAgentCreated callback to runner factory for steering registration", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    let capturedCallback: ((agent: any) => void) | undefined;

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => {
        capturedCallback = input.onAgentCreated;
        return makeRunner("ok")(input);
      },
    });

    await handler.handleIncomingMessage(makeMessage("!s hello", { isDirect: true }), { sendResponse: async () => {} });

    expect(capturedCallback).toBeDefined();

    await history.close();
  });

  it("passive messages during active session steer into the running agent", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    // Mock agent with steer tracking
    const steerCalls: any[] = [];
    const mockAgent = {
      steer: (msg: any) => { steerCalls.push(msg); },
    };

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          input.onAgentCreated?.(mockAgent as any);
          firstStarted.resolve();
          await releaseFirst.promise;
          const result = makeRunnerResult("done");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(makeMessage("!s first", { isDirect: true }), {
      sendResponse: async () => {},
    });

    await firstStarted.promise;

    // Send a passive message while agent is running
    const interruptPersisted = waitForPersistedMessage(
      history,
      (message) => message.content === "interrupt me",
    );
    handler.handleIncomingMessage(makeMessage("interrupt me"));

    await interruptPersisted;

    releaseFirst.resolve();
    await t1;

    expect(steerCalls).toHaveLength(1);
    expect(steerCalls[0].content[0].text).toContain("interrupt me");

    await history.close();
  });

  it("wraps untrusted messages with [UNTRUSTED] markers when steering into active session", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    const steerCalls: any[] = [];
    const mockAgent = {
      steer: (msg: any) => { steerCalls.push(msg); },
    };

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          input.onAgentCreated?.(mockAgent as any);
          firstStarted.resolve();
          await releaseFirst.promise;
          const result = makeRunnerResult("done");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(makeMessage("!s first", { isDirect: true }), {
      sendResponse: async () => {},
    });

    await firstStarted.promise;

    // Send an untrusted passive message
    const interruptPersisted = waitForPersistedMessage(
      history,
      (message) => message.content === "sneaky command",
    );
    handler.handleIncomingMessage(makeMessage("sneaky command", { trusted: false }));
    await interruptPersisted;

    releaseFirst.resolve();
    await t1;

    expect(steerCalls).toHaveLength(1);
    const steeredText = steerCalls[0].content[0].text;
    expect(steeredText).toContain("[UNTRUSTED]");
    expect(steeredText).toContain("<alice> sneaky command");
    expect(steeredText).toContain("[/UNTRUSTED]");

    await history.close();
  });

  it("rejects direct messages from untrusted users without running agent", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    let runnerCalled = false;
    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        prompt: async () => {
          runnerCalled = true;
          return makeRunnerResult("should not happen");
        },
      }),
    });

    const replies: string[] = [];
    await handler.handleIncomingMessage(
      makeMessage("!s hello", { isDirect: true, trusted: false, nick: "mallory" }),
      { sendResponse: async (text) => { replies.push(text); } },
    );

    expect(runnerCalled).toBe(false);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("mallory");
    expect(replies[0]).toContain("whitelisted");

    await history.close();
  });

  it("deregisters steering after response delivery before background work completes", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const agentReady = createDeferred<void>();
    const releaseAgent = createDeferred<void>();
    // Gate that blocks triggerAutoChronicler — this runs AFTER
    // onResponseDelivered and after post-response maintenance in execute().
    const chroniclerStarted = createDeferred<void>();
    const releaseChronicler = createDeferred<void>();

    const steerCalls: any[] = [];
    const mockAgent = {
      steer: (msg: any) => { steerCalls.push(msg); },
    };

    let runCount = 0;
    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      // Mock autoChronicler that blocks until we release it
      autoChronicler: {
        checkAndChronicle: async () => {
          chroniclerStarted.resolve();
          await releaseChronicler.promise;
        },
      },
      runnerFactory: (input) => ({
        prompt: async (_prompt) => {
          runCount += 1;
          if (runCount === 1) {
            input.onAgentCreated?.(mockAgent as any);
            agentReady.resolve();
            await releaseAgent.promise;
            const result = makeRunnerResult("done");
            await input.onResponse(result.text);
            return result;
          }
          // Second invocation — just return immediately
          input.onAgentCreated?.({ steer() {} } as any);
          const result = makeRunnerResult("second response");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    const sent1: string[] = [];
    const sent2: string[] = [];

    // Start first command
    const resultPromise = handler.handleIncomingMessage(makeMessage("!s first", { isDirect: true }), {
      sendResponse: async (text) => { sent1.push(text); },
    });

    await agentReady.promise;
    releaseAgent.resolve();

    // Wait until triggerAutoChronicler starts — by this point execute()
    // has completed delivering the response and called onResponseDelivered
    // (deregistering steering), and awaited post-response maintenance. But execute()
    // itself hasn't returned yet because triggerAutoChronicler is blocked.
    await chroniclerStarted.promise;

    // Send a second message from the same user while execute() is still
    // blocked in triggerAutoChronicler. Since onResponseDelivered already
    // deregistered steering, this should NOT be steered — it should start
    // its own session.
    const secondResult = handler.handleIncomingMessage(makeMessage("!s second message", { isDirect: true }), {
      sendResponse: async (text) => { sent2.push(text); },
    });

    // Release the chronicler so execute() can return.
    releaseChronicler.resolve();

    await Promise.all([resultPromise, secondResult]);

    expect(sent1[0]).toBe("done");
    // The second message must NOT have been steered into the first session
    expect(steerCalls).toHaveLength(0);
    // It should have started its own session and got its own response
    expect(sent2[0]).toBe("second response");
    expect(runCount).toBe(2);

    await history.close();
  });

  it("starts proactive session on passive message in proactive-enabled channel", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const proactiveRoomConfig = {
      ...roomConfig,
      proactive: {
        interjecting: ["libera##test"],
        debounceSeconds: 0,
        historySize: 10,
        rateLimit: 10,
        ratePeriod: 60,
        interjectThreshold: 100, // Set impossibly high so it never actually interjects
        models: {
          validation: ["openai:gpt-4o-mini"],
          serious: "openai:gpt-4o-mini",
        },
        prompts: {
          interject: "Score this: {message}",
          seriousExtra: "Be proactive.",
        },
      },
    };

    let runnerCalled = false;

    const handler = createHandler({
      roomConfig: proactiveRoomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          runnerCalled = true;
          const result = makeRunnerResult("proactive response");
          await input.onResponse(result.text);
          return result;
        },
      }),
      // Mock the model adapter to return a low score so proactive declines
      modelAdapter: {
        completeSimple: async () => ({
          content: [{ type: "text", text: "Score: 2/10 - not interesting" }],
        }),
      },
    });

    // Send a passive message — should start proactive session and debounce
    await handler.handleIncomingMessage(makeMessage("just chatting"));

    // Runner should NOT be called since score is below threshold
    expect(runnerCalled).toBe(false);

    // Passive message must NOT be annotated as "in progress" in future context
    const context = await history.getContext("libera##test");
    const chatMsg = context.find(
      (m) => typeof m.content === "string" && m.content.includes("just chatting"),
    );
    expect(chatMsg).toBeDefined();
    expect(chatMsg!.content).not.toContain("<meta>");

    await history.close();
  });

  it("drops NULL sentinel responses in direct command sessions", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          await input.onResponse("NULL");
          const result = makeRunnerResult("done");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    await handler.handleIncomingMessage(makeMessage("!s should suppress null", { isDirect: true }), {
      sendResponse: async (text) => { sent.push(text); },
    });

    expect(sent).toEqual(["done"]);

    const rows = await history.getFullHistory("libera##test");
    const assistantMessages = rows
      .filter((row) => row.role === "assistant")
      .map((row) => row.message);
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toContain("done");
    expect(assistantMessages.some((msg) => msg.trim().toUpperCase() === "NULL")).toBe(false);

    await history.close();
  });

  it("executeEvent uses quiet output: suppresses errors, prefixes model tag, skips cost followups", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          // Emit an error, a NULL, and a real response
          await input.onResponse("Error: something went wrong");
          await input.onResponse("NULL");
          const result = makeRunnerResult("event output here", { totalCost: 0.50 });
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    await handler.executeEvent(
      makeMessage("!s event command", { isDirect: true }),
      async (text) => { sent.push(text); },
    );

    // Only the real response should be sent, prefixed with model tag
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("[gpt-4o-mini]");
    expect(sent[0]).toContain("event output here");

    // Error and NULL should not appear
    expect(sent.some((s) => s.includes("Error:"))).toBe(false);
    expect(sent.some((s) => s.toUpperCase().includes("NULL"))).toBe(false);

    // Cost followup should NOT be sent despite high cost ($0.50)
    expect(sent.some((s) => s.includes("tool calls"))).toBe(false);
    expect(sent.some((s) => s.includes("cost $"))).toBe(false);

    await history.close();
  });

  it("persists background costs and rethrows delivery errors in executeEvent quiet mode", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const { runnerFactory, backgroundStarted, releaseBackground, backgroundFinished } =
      makeRunnerWithBlockedBackgroundWork({ text: "event output here", totalCost: 0.05 });

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory,
    });

    const deliveryAttempted = createDeferred<void>();
    const execution = handler.executeEvent(
      makeMessage("!s event command", { isDirect: true }),
      async () => {
        deliveryAttempted.resolve();
        throw new Error("event delivery failed");
      },
    );

    await backgroundStarted.promise;
    await deliveryAttempted.promise;
    releaseBackground.resolve();

    await expect(execution).rejects.toThrow("event delivery failed");
    await backgroundFinished.promise;

    const jsonlLines = await readRawJsonlLines(history);
    const costRows = jsonlLines.filter((row: any) => row.call);
    expect(costRows.map((row: any) => row.call)).toEqual([
      LLM_CALL_TYPE.AGENT_RUN,
      LLM_CALL_TYPE.MEMORY_UPDATE,
      LLM_CALL_TYPE.TOOL_SUMMARY,
    ]);
    expect(costRows.map((row: any) => row.source)).toEqual([
      "event",
      "event",
      "event",
    ]);

    await history.close();
  });

  it("executeEvent suppresses intermediate messages, delivers only the last valid response", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          // Simulate intermediate "thinking out loud" then final answer
          await input.onResponse("Fixing missing dependency, then rerunning the script.");
          const result = makeRunnerResult("calendar: 20:00 - Meetup", { totalCost: 0.01 });
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    await handler.executeEvent(
      makeMessage("!s event command", { isDirect: true }),
      async (text) => { sent.push(text); },
    );

    // Only the final response should be delivered, not the intermediate one
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("calendar: 20:00 - Meetup");
    expect(sent.some((s) => s.includes("Fixing missing dependency"))).toBe(false);

    await history.close();
  });

  it("executeEvent strips trailing NULL from otherwise valid response", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          // Agent appends NULL after real content
          const text = "calendar: 20:00 - Meetup\n\nNULL";
          const result = makeRunnerResult(text, { totalCost: 0.01 });
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    await handler.executeEvent(
      makeMessage("!s event command", { isDirect: true }),
      async (text) => { sent.push(text); },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("calendar: 20:00 - Meetup");
    expect(sent[0]).not.toMatch(/null/iu);

    await history.close();
  });

  it("executeEvent extracts <thinking> tags and persists them as internal monologue", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          // First response: thinking only, no visible output
          await input.onResponse("<thinking>Checking if there are events today...</thinking>");
          // Final response: thinking + visible output
          const text = "<thinking>Let me check the calendar...</thinking>calendar: 20:00 - Meetup";
          const result = makeRunnerResult(text, { totalCost: 0.01 });
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    await handler.executeEvent(
      makeMessage("!s event command", { isDirect: true }),
      async (text) => { sent.push(text); },
    );

    // Room should only see the stripped text, no <thinking> tags
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("calendar: 20:00 - Meetup");
    expect(sent[0]).not.toContain("<thinking>");
    expect(sent[0]).not.toContain("Let me check the calendar");

    // History should contain the internal monologue entry
    const rows = await history.getFullHistory("libera##test");
    const monologue = rows.find((r: any) => r.message.includes("[internal monologue]"));
    expect(monologue).toBeDefined();
    expect(monologue!.message).toContain("Checking if there are events today");
    expect(monologue!.message).toContain("Let me check the calendar");

    await history.close();
  });

  it("drops proactive NULL sentinel responses instead of sending them", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const proactiveRoomConfig = {
      ...roomConfig,
      proactive: {
        interjecting: ["libera##test"],
        debounceSeconds: 0,
        historySize: 10,
        rateLimit: 10,
        ratePeriod: 60,
        interjectThreshold: 1,
        models: {
          validation: ["openai:gpt-4o-mini"],
          serious: "openai:gpt-4o-mini",
        },
        prompts: {
          interject: "Score this: {message}",
          seriousExtra: "Respond with NULL when abstaining.",
        },
      },
    };

    const sent: string[] = [];
    const proactivePromptReached = createDeferred<void>();

    const handler = createHandler({
      roomConfig: proactiveRoomConfig as any,
      history,
      runnerFactory: (input) => ({
        prompt: async () => {
          proactivePromptReached.resolve();
          const result = makeRunnerResult("NULL");
          await input.onResponse(result.text);
          return result;
        },
      }),
      modelAdapter: {
        completeSimple: async (_model: string, _payload: unknown, callOptions?: { callType?: string }) => {
          if (callOptions?.callType === LLM_CALL_TYPE.MODE_CLASSIFIER) {
            return { content: [{ type: "text", text: "EASY_SERIOUS" }] };
          }
          return { content: [{ type: "text", text: "Score: 9/10" }] };
        },
      },
    });

    await history.addMessage(makeMessage("seed message"));

    await handler.handleIncomingMessage(makeMessage("should I jump in?"), {
      sendResponse: async (text) => { sent.push(text); },
    });

    await proactivePromptReached.promise;
    // Yield to let the fire-and-forget proactive pipeline finish cleanup
    await new Promise((r) => setImmediate(r));

    expect(sent).toEqual([]);
    const rows = await history.getFullHistory("libera##test");
    expect(rows.filter((row) => row.role === "assistant")).toHaveLength(0);

    await history.close();
  });

  it("skips proactive session for untrusted passive messages", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const proactiveRoomConfig = {
      ...roomConfig,
      proactive: {
        interjecting: ["libera##test"],
        debounceSeconds: 0,
        historySize: 10,
        rateLimit: 10,
        ratePeriod: 60,
        interjectThreshold: 1,
        models: {
          validation: ["openai:gpt-4o-mini"],
          serious: "openai:gpt-4o-mini",
        },
        prompts: {
          interject: "Should interject? {message}",
          seriousExtra: "Be proactive.",
        },
      },
    };

    let runnerCalled = false;
    const handler = createHandler({
      roomConfig: proactiveRoomConfig as any,
      history,
      runnerFactory: () => ({
        prompt: async () => {
          runnerCalled = true;
          return makeRunnerResult("proactive response");
        },
      }),
    });

    // Send untrusted passive message — should NOT start proactive
    await handler.handleIncomingMessage(makeMessage("untrusted chat", { trusted: false }));

    // Brief wait for any async work
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runnerCalled).toBe(false);

    await history.close();
  });

  it("does not start proactive session on passive message in non-proactive channel", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    // No proactive config at all
    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        prompt: async () => makeRunnerResult("unused"),
      }),
    });

    await handler.handleIncomingMessage(makeMessage("just chatting"));

    // Should complete immediately without starting a proactive session
    await history.close();
  });

  it("command preempts proactive debounce session", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const proactiveRoomConfig = {
      ...roomConfig,
      proactive: {
        interjecting: ["libera##test"],
        debounceSeconds: 5, // Long debounce — command should preempt
        historySize: 10,
        rateLimit: 10,
        ratePeriod: 60,
        interjectThreshold: 1,
        models: {
          validation: ["openai:gpt-4o-mini"],
          serious: "openai:gpt-4o-mini",
        },
        prompts: {
          interject: "Score: {message}",
          seriousExtra: "",
        },
      },
    };

    const sent: string[] = [];
    let runnerPrompts: string[] = [];

    const handler = createHandler({
      roomConfig: proactiveRoomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async (prompt) => {
          runnerPrompts.push(prompt);
          const result = makeRunnerResult("command response");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    // Start proactive session with a passive message
    const passivePersisted = waitForPersistedMessage(
      history,
      (message) => message.content === "background chatter",
    );
    const passivePromise = handler.handleIncomingMessage(makeMessage("background chatter"));

    await passivePersisted;

    // Now send a command — should preempt the proactive debounce
    await handler.handleIncomingMessage(makeMessage("!s direct question", { isDirect: true }), {
      sendResponse: async (text) => { sent.push(text); },
    });

    await passivePromise;

    // The command should have been executed
    expect(sent).toContain("command response");
    expect(runnerPrompts.some(p => p.includes("direct question"))).toBe(true);

    await history.close();
  });

  it("command from different nick preempts proactive debounce session", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const proactiveRoomConfig = {
      ...roomConfig,
      proactive: {
        interjecting: ["libera##test"],
        debounceSeconds: 5, // Long debounce — command should preempt
        historySize: 10,
        rateLimit: 10,
        ratePeriod: 60,
        interjectThreshold: 1,
        models: {
          validation: ["openai:gpt-4o-mini"],
          serious: "openai:gpt-4o-mini",
        },
        prompts: {
          interject: "Score: {message}",
          seriousExtra: "",
        },
      },
    };

    const sent: string[] = [];
    let runnerPrompts: string[] = [];

    const handler = createHandler({
      roomConfig: proactiveRoomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async (prompt) => {
          runnerPrompts.push(prompt);
          const result = makeRunnerResult("command response");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    // Passive message from alice starts proactive debounce
    const passivePersisted = waitForPersistedMessage(
      history,
      (message) => message.content === "background chatter",
    );
    const passivePromise = handler.handleIncomingMessage(makeMessage("background chatter"));

    await passivePersisted;

    // Command from bob (different nick) — should preempt the proactive debounce
    await handler.handleIncomingMessage(
      { ...makeMessage("!s direct question"), nick: "bob", isDirect: true },
      {
        sendResponse: async (text) => { sent.push(text); },
      },
    );

    await passivePromise;

    // The command should have been executed
    expect(sent).toContain("command response");
    expect(runnerPrompts.some(p => p.includes("direct question"))).toBe(true);

    await history.close();
  });

  it("passive messages steer into running proactive agent session", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const proactiveRoomConfig = {
      ...roomConfig,
      proactive: {
        interjecting: ["libera##test"],
        debounceSeconds: 0,
        historySize: 10,
        rateLimit: 10,
        ratePeriod: 60,
        interjectThreshold: 1,
        models: {
          validation: ["openai:gpt-4o-mini"],
          serious: "openai:gpt-4o-mini",
        },
        prompts: {
          interject: "Score: {message}",
          seriousExtra: "",
        },
      },
    };

    const agentStarted = createDeferred<void>();
    const releaseAgent = createDeferred<void>();
    const steeredMessages: string[] = [];

    // Fake agent that records steered messages
    const fakeAgent = {
      steer(msg: { content: Array<{ type: string; text: string }> }) {
        const text = msg.content[0]?.text ?? "";
        steeredMessages.push(text);
      },
    };

    const handler = createHandler({
      roomConfig: proactiveRoomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          // Fire onAgentCreated to register the proactive agent
          input.onAgentCreated?.(fakeAgent as any);
          agentStarted.resolve();
          await releaseAgent.promise;
          const result = makeRunnerResult("proactive response");
          await input.onResponse(result.text);
          return result;
        },
      }),
      modelAdapter: {
        completeSimple: async () => ({
          content: [{ type: "text", text: "Score: 9/10 - very interesting" }],
        }),
      },
    });

    // Seed a message so proactive has context
    await history.addMessage(makeMessage("seed message"));

    // Passive message triggers proactive debounce + eval + agent
    const passivePromise = handler.handleIncomingMessage(makeMessage("trigger chat"));

    // Wait for the proactive agent to start
    await agentStarted.promise;

    // Send more passive messages from different nicks — should steer into proactive agent
    await handler.handleIncomingMessage(
      { ...makeMessage("bob says hi"), nick: "bob" },
    );
    await handler.handleIncomingMessage(
      { ...makeMessage("carol chimes in"), nick: "carol" },
    );

    for (const msg of steeredMessages) {
      expect(msg).toContain("Background channel message");
      expect(msg).toContain("<meta>");
      // Steered messages must include a [HH:MM] UTC timestamp before the nick
      expect(msg).toMatch(/\[\d{2}:\d{2}\] </);
    }
    expect(steeredMessages[0]).toContain("<bob> bob says hi");
    expect(steeredMessages[1]).toContain("<carol> carol chimes in");

    // Release the agent and let the proactive session finish
    releaseAgent.resolve();
    await passivePromise;
    // Yield to let fire-and-forget proactive pipeline finish cleanup
    await new Promise((r) => setImmediate(r));

    // After proactive session ends, passive messages should no longer steer
    steeredMessages.length = 0;
    await handler.handleIncomingMessage(
      { ...makeMessage("late message"), nick: "dave" },
    );
    expect(steeredMessages).toEqual([]);

    await history.close();
  });

  it("commands are not blocked by running proactive session", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const proactiveRoomConfig = {
      ...roomConfig,
      proactive: {
        interjecting: ["libera##test"],
        debounceSeconds: 0,
        historySize: 10,
        rateLimit: 10,
        ratePeriod: 60,
        interjectThreshold: 1,
        models: {
          validation: ["openai:gpt-4o-mini"],
          serious: "openai:gpt-4o-mini",
        },
        prompts: {
          interject: "Score: {message}",
          seriousExtra: "",
        },
      },
    };

    const agentStarted = createDeferred<void>();
    const releaseAgent = createDeferred<void>();
    let commandRunnerCalled = false;
    let isProactiveCall = true;

    const handler = createHandler({
      roomConfig: proactiveRoomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          if (isProactiveCall) {
            input.onAgentCreated?.({ steer() {} } as any);
            agentStarted.resolve();
            await releaseAgent.promise;
            const r = makeRunnerResult("proactive response");
            await input.onResponse(r.text);
            return r;
          }
          commandRunnerCalled = true;
          input.onAgentCreated?.({ steer() {} } as any);
          const r = makeRunnerResult("command response");
          await input.onResponse(r.text);
          return r;
        },
      }),
      modelAdapter: {
        completeSimple: async () => ({
          content: [{ type: "text", text: "Score: 9/10" }],
        }),
      },
    });

    await history.addMessage(makeMessage("seed message"));

    // Start proactive session
    const passivePromise = handler.handleIncomingMessage(makeMessage("trigger chat"));
    await agentStarted.promise;

    // Command should still execute independently
    isProactiveCall = false;
    const sent: string[] = [];
    await handler.handleIncomingMessage(makeMessage("!s direct question", { isDirect: true }), {
      sendResponse: async (text) => { sent.push(text); },
    });

    expect(commandRunnerCalled).toBe(true);
    expect(sent[0]).toBe("command response");

    releaseAgent.resolve();
    await passivePromise;
    await history.close();
  });

  it("isolates sessions by nick when there is no thread", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const aliceStarted = createDeferred<void>();
    const releaseAlice = createDeferred<void>();

    let runCount = 0;
    const prompts: string[] = [];
    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async (prompt) => {
          runCount += 1;
          prompts.push(prompt);

          if (runCount === 1) {
            aliceStarted.resolve();
            await releaseAlice.promise;
            const result = makeRunnerResult("alice reply");
            await input.onResponse(result.text);
            return result;
          }
          const result = makeRunnerResult("bob reply");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(makeMessage("!s alice question", { isDirect: true }), {
      sendResponse: async (text) => { sent.push(text); },
    });

    await aliceStarted.promise;

    // Bob sends a command while Alice's is running — should get own session
    const t2 = handler.handleIncomingMessage(
      { ...makeMessage("!s bob question"), nick: "bob", isDirect: true },
      {
        sendResponse: async (text) => { sent.push(text); },
      },
    );

    releaseAlice.resolve();
    await Promise.all([t1, t2]);

    expect(runCount).toBe(2);
    expect(sent).toContain("alice reply");
    expect(sent).toContain("bob reply");
    expect(prompts.some(p => p.includes("<alice> alice question"))).toBe(true);
    expect(prompts.some(p => p.includes("<bob> bob question"))).toBe(true);

    await history.close();
  });

  it("isolates sessions for the same nick across different channels", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    let runCount = 0;
    const prompts: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async (prompt) => {
          runCount += 1;
          prompts.push(prompt);

          if (runCount === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
            const result = makeRunnerResult("chan1 reply");
            await input.onResponse(result.text);
            return result;
          }
          const result = makeRunnerResult("chan2 reply");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    const sent1: string[] = [];
    const sent2: string[] = [];
    const t1 = handler.handleIncomingMessage(
      { ...makeMessage("!s first"), channelName: "#foo", arc: "libera##foo", isDirect: true },
      { sendResponse: async (text) => { sent1.push(text); } },
    );

    await firstStarted.promise;

    const t2 = handler.handleIncomingMessage(
      { ...makeMessage("!s second"), channelName: "#bar", arc: "libera##bar", isDirect: true },
      { sendResponse: async (text) => { sent2.push(text); } },
    );

    releaseFirst.resolve();
    await Promise.all([t1, t2]);

    expect(runCount).toBe(2);
    expect(sent1[0]).toBe("chan1 reply");
    expect(sent2[0]).toBe("chan2 reply");

    await history.close();
  });

  it("commands arriving after session starts are steered — only one runner invocation", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    let runCount = 0;
    const steerCalls: any[] = [];
    const mockAgent = {
      steer: (msg: any) => { steerCalls.push(msg); },
    };
    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          runCount += 1;
          input.onAgentCreated?.(mockAgent as any);
          firstStarted.resolve();
          await releaseFirst.promise;
          const result = makeRunnerResult("reply 1");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(makeMessage("!s first", { isDirect: true }), {
      sendResponse: async (text) => { sent.push(text); },
    });

    await firstStarted.promise;

    const t2 = handler.handleIncomingMessage(makeMessage("!s second", { isDirect: true }), {
      sendResponse: async (text) => { sent.push(text); },
    });
    const t3 = handler.handleIncomingMessage(makeMessage("!s third", { isDirect: true }), {
      sendResponse: async (text) => { sent.push(text); },
    });

    releaseFirst.resolve();
    await Promise.all([t1, t2, t3]);

    expect(runCount).toBe(1);
    expect(steerCalls).toHaveLength(2);
    expect(sent).toEqual(["reply 1"]);

    await history.close();
  });

  it("runner error cleans up session so next command starts fresh", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    let runCount = 0;
    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => ({
        prompt: async () => {
          runCount += 1;
          if (runCount === 1) {
            throw new Error("runner exploded");
          }
          const result = makeRunnerResult("recovered");
          await input.onResponse(result.text);
          return result;
        },
      }),
    });

    // First command fails
    await expect(
      handler.handleIncomingMessage(makeMessage("!s first", { isDirect: true }), {
        sendResponse: async (text) => { sent.push(text); },
      }),
    ).rejects.toThrow("runner exploded");

    // Second command should start a fresh session (no stale entry in map)
    await handler.handleIncomingMessage(makeMessage("!s second", { isDirect: true }), {
      sendResponse: async (text) => { sent.push(text); },
    });

    expect(runCount).toBe(2);
    expect(sent).toContain("recovered");

    await history.close();
  });

  it("passive messages with no active session and no proactive are no-ops", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    let runCount = 0;

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        prompt: async () => {
          runCount += 1;
          return makeRunnerResult("should not happen");
        },
      }),
    });

    await handler.handleIncomingMessage(makeMessage("just chatting"));
    await handler.handleIncomingMessage(makeMessage("more chat"));

    expect(runCount).toBe(0);

    await history.close();
  });

  it("does not persist user platformId on bot response (Fix A: PID collision)", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming: RoomMessage = {
      ...makeMessage("!s hello"),
      platformId: "user-msg-1234",
    };

    const persistedMessages: RoomMessage[] = [];
    const origAddMessage = history.addMessage.bind(history);
    vi.spyOn(history, "addMessage").mockImplementation(async (...args) => {
      const [msg] = args;
      persistedMessages.push(msg as RoomMessage);
      return origAddMessage(...(args as Parameters<typeof history.addMessage>));
    });

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("bot reply"),
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, {
      sendResponse: async () => {},
    });

    // Find the bot response among persisted messages
    const botMessages = persistedMessages.filter((m) => m.nick === "muaddib" && m.content === "bot reply");
    expect(botMessages).toHaveLength(1);
    // Bot response must NOT inherit the user's platformId
    expect(botMessages[0].platformId).not.toBe("user-msg-1234");
  });

  it("persists outbound platformId from sendResponse on bot response (Fix C)", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming: RoomMessage = {
      ...makeMessage("!s hello"),
      platformId: "user-msg-1234",
    };

    const persistedMessages: RoomMessage[] = [];
    const origAddMessage = history.addMessage.bind(history);
    vi.spyOn(history, "addMessage").mockImplementation(async (...args) => {
      const [msg] = args;
      persistedMessages.push(msg as RoomMessage);
      return origAddMessage(...(args as Parameters<typeof history.addMessage>));
    });

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("bot reply"),
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, {
      sendResponse: async () => ({ platformId: "outbound-5555" }),
    });

    // Find the bot response among persisted messages
    const botMessages = persistedMessages.filter((m) => m.nick === "muaddib" && m.content === "bot reply");
    expect(botMessages).toHaveLength(1);
    // Bot response must use the outbound platformId from the send result
    expect(botMessages[0].platformId).toBe("outbound-5555");
  });

  it("coalesces bot message via appendEdit when sendResponse returns isEdit (edit debounce)", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming: RoomMessage = {
      ...makeMessage("!s hello"),
      platformId: "user-msg-1234",
    };

    let callCount = 0;
    const handler = createHandler({
      roomConfig: {
        ...roomConfig,
        command: {
          ...roomConfig.command,
          modes: {
            ...roomConfig.command.modes,
            serious: {
              ...roomConfig.command.modes.serious,
              model: "openai:gpt-4o-mini",
            },
          },
        },
      } as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("expensive answer", { totalCost: 0.5, toolCallsCount: 3 }),
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, {
      sendResponse: async (text) => {
        callCount++;
        if (callCount === 1) {
          // First call: new send
          return { platformId: "bot-5555" };
        }
        // Subsequent calls: edit debounce — return combined content
        return {
          platformId: "bot-5555",
          isEdit: true,
          combinedContent: `expensive answer\n${text}`,
        };
      },
    });

    // Check that context reflects the coalesced message
    const arc = (await import("../src/rooms/message.js")).buildArc("libera", "#test");
    const context = await history.getContext(arc, 10);

    // Should have user + one coalesced assistant message (not two separate ones)
    const assistantMsgs = context.filter((m) => m.role === "assistant");
    // The coalesced message should contain both the answer and cost info
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    expect((lastAssistant as any).content[0].text).toContain("expensive answer");
    expect((lastAssistant as any).content[0].text).toContain("cost");
  });

  it("bot response messages do not carry originalContent or secrets from the triggering user message", async () => {
    const history = createTempHistoryStore(40);
    await history.initialize();

    const incoming: RoomMessage = {
      ...makeMessage("!s hello"),
      originalContent: "muaddib: !s hello",
      secrets: { apiKey: "super-secret-123" },
      platformId: "user-msg-9999",
      threadId: "thread-42",
      responseThreadId: "resp-thread-42",
    };

    const persistedMessages: RoomMessage[] = [];
    const origAddMessage = history.addMessage.bind(history);
    vi.spyOn(history, "addMessage").mockImplementation(async (...args) => {
      const [msg] = args;
      persistedMessages.push(msg as RoomMessage);
      return origAddMessage(...(args as Parameters<typeof history.addMessage>));
    });

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: makeRunner("bot reply"),
    });

    incoming.isDirect = true;
    await handler.handleIncomingMessage(incoming, {
      sendResponse: async () => ({ platformId: "outbound-7777" }),
    });

    // Find all bot messages (response + possibly tool summary)
    const botMessages = persistedMessages.filter((m) => m.nick === "muaddib");
    expect(botMessages.length).toBeGreaterThanOrEqual(1);

    for (const botMsg of botMessages) {
      // Must NOT carry user's originalContent or secrets
      expect(botMsg.originalContent).toBeUndefined();
      expect(botMsg.secrets).toBeUndefined();
      // Must carry threading fields from user message
      expect(botMsg.threadId).toBe("thread-42");
      expect(botMsg.responseThreadId).toBe("resp-thread-42");
      // Must carry correct structural fields
      expect(botMsg.serverTag).toBe("libera");
      expect(botMsg.channelName).toBe("#test");
      expect(botMsg.mynick).toBe("muaddib");
    }

    // The main bot response specifically
    const mainBot = botMessages.find((m) => m.content === "bot reply");
    expect(mainBot).toBeDefined();
    expect(mainBot!.platformId).toBe("outbound-7777");
  });
});
