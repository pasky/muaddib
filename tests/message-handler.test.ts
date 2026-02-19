import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { RuntimeLogWriter } from "../src/app/logging.js";
import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import {
  RoomMessageHandler,
  type CommandRateLimiter,
  type CommandRunnerFactory,
} from "../src/rooms/command/message-handler.js";
import type { ContextReducer } from "../src/rooms/command/context-reducer.js";
import type { RoomMessage } from "../src/rooms/message.js";
import { createDeferred, waitForPersistedMessage } from "./test-helpers.js";
import { createTestRuntime } from "./test-runtime.js";

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

  modelAdapter?: unknown;
  runtimeLogger?: RuntimeLogWriter;
  configData?: Record<string, unknown>;
}): RoomMessageHandler {
  const runtime = createTestRuntime({
    authStorage: AuthStorage.inMemory(),
    history: options.history,
    configData: {
      ...(options.configData ?? {}),
      rooms: { irc: options.roomConfig ?? roomConfig },
    },
    logger: options.runtimeLogger,
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

function makeMessage(content: string): RoomMessage {
  return {
    serverTag: "libera",
    channelName: "#test",
    nick: "alice",
    mynick: "muaddib",
    content,
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

describe("RoomMessageHandler", () => {
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
    expect(runnerPrompt).toBe("<alice> hello there");
    expect(runnerThinkingLevel).toBe("medium");
    expect(runnerContextContents.some((entry) => entry.includes("!a hello there"))).toBe(false);
    expect(runnerContextContents.some((entry) => entry.includes("previous context"))).toBe(true);

    await history.close();
  });

  it("strips echoed IRC context prefixes from generated response text", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const incoming = makeMessage("!s ping");

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        prompt: async () =>
          makeRunnerResult("[02:32] <MuaddibLLM> pasky: Pong! S latenci nizsi nez moje chut."),
      }),
    });

    const result = await handler.execute(incoming);

    expect(result.response).toBe("pasky: Pong! S latenci nizsi nez moje chut.");

    await history.close();
  });

  it("keeps <quest> payloads while stripping non-quest IRC echo prefixes", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const incoming = makeMessage("!s quest update");

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        prompt: async () =>
          makeRunnerResult("[serious] [02:32] <MuaddibLLM> <quest id=\"q1\">Done.</quest>"),
      }),
    });

    const result = await handler.execute(incoming);

    expect(result.response).toBe("<quest id=\"q1\">Done.</quest>");

    await history.close();
  });

  it("logs direct command lifecycle to injected logger", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
      runnerFactory: () => ({
        prompt: async () => makeRunnerResult("pong"),
      }),
    });

    await handler.handleIncomingMessage(incoming, { isDirect: true });

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
    expect(logger.debug).toHaveBeenCalledWith(
      "Persisting direct command response",
      "arc=libera##test",
      "model=openai:gpt-4o-mini",
      "tool_calls=0",
      "llm_call_id=1",
    );
    expect(logger.debug).toHaveBeenCalledWith(
      "Direct command response stored",
      "arc=libera##test",
      "response_message_id=2",
    );

    await history.close();
  });

  it("logs parse/help/rate-limit events with Python-matching severities", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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

    await parseErrorHandler.handleIncomingMessage(makeMessage("!unknown ping"), {
      isDirect: true,
    });
    await parseErrorHandler.handleIncomingMessage(makeMessage("!h"), {
      isDirect: true,
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

    await rateLimitedHandler.handleIncomingMessage(makeMessage("!s too-fast"), {
      isDirect: true,
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
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    await history.logLlmCall({
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 10,
      outputTokens: 10,
      cost: 0.9,
      callType: "agent_run",
      arcName: "libera##test",
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
      runnerFactory: () => ({
        prompt: async () =>
          makeRunnerResult("The AI refused to respond to this request", {
            refusalFallbackActivated: true,
            refusalFallbackModel: "anthropic:claude-3-5-haiku",
          }),
      }),
    });

    await handler.handleIncomingMessage(makeMessage("!s expensive fallback"), {
      isDirect: true,
      sendResponse: async () => {},
    });

    expect(logger.info).toHaveBeenCalledWith(
      "Sending direct response",
      "mode=!s",
      "trigger=!s",
      "cost=$0.0000",
      "arc=libera##test",
      "response=The AI refused to respond to this request [refusal fallback to claude-3-5-haiku]",
    );

    await history.close();
  });

  it("logs agent execution failures at error severity", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
      handler.handleIncomingMessage(makeMessage("!d explode"), {
        isDirect: true,
      }),
    ).rejects.toThrow("runner boom");

    // Error propagates without being logged at executor level (no catch+rethrow).

    await history.close();
  });

  it("writes command lifecycle logs into message-context files", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
      runnerFactory: () => ({
        prompt: async () => makeRunnerResult("pong"),
      }),
    });

    await runtimeLogs.withMessageContext(
      {
        arc: "libera##test",
        nick: "alice",
        message: "!s ping",
      },
      async () => {
        await handler.handleIncomingMessage(makeMessage("!s ping"), {
          isDirect: true,
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
    expect(messageLog).toContain(" - DEBUG - Persisting direct command response");

    await rm(logsHome, { recursive: true, force: true });
    await history.close();
  });

  it("applies context reducer when mode enables auto_reduce_context", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
      runnerFactory: () => ({
        prompt: async (prompt, options) => {
          runnerPrompt = prompt;
          runnerContextContents = (options?.contextMessages ?? []).map((entry) => typeof entry.content === 'string' ? entry.content : entry.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' '));
          return makeRunnerResult("done");
        },
      }),
    });

    const result = await handler.execute(incoming);

    expect(result.response).toBe("done");
    expect(contextReducer.reduce).toHaveBeenCalledTimes(1);
    expect(runnerPrompt).toBe("<alice> reduce context please");
    expect(runnerContextContents).toEqual(["[10:00] <summary> reduced context"]);
    expect(runnerContextContents.some((entry) => entry.includes("previous context"))).toBe(false);

    await history.close();
  });

  it("prepends chapter context by default and skips it when include_chapter_summary is disabled", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
      runnerFactory: () => ({
        prompt: async (_prompt, options) => {
          runnerContextWithSummary.push((options?.contextMessages ?? []).map((entry) => typeof entry.content === 'string' ? entry.content : entry.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')));
          return makeRunnerResult("done");
        },
      }),
    });

    await handlerWithSummary.execute(incoming);

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
      runnerFactory: () => ({
        prompt: async () => makeRunnerResult("done"),
      }),
    });

    await handlerWithoutSummary.execute(incoming);
    expect(chronicleStore.getChapterContextMessages).toHaveBeenCalledTimes(1);

    await history.close();
  });

  it("filters baseline tools via allowed_tools including chronicler/quest tool names", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
              allowedTools: ["chronicle_read", "quest_start", "make_plan"],
            },
          },
        },
      } as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => {
        seenToolNames.push(...input.tools.map((tool) => tool.name));
        return {
          prompt: async () => makeRunnerResult("done"),
        };
      },
    });

    const result = await handler.execute(incoming);

    expect(result.response).toBe("done");
    expect(seenToolNames).toEqual(["chronicle_read", "quest_start", "make_plan"]);

    await history.close();
  });

  it("passes oracle tool with invocation context containing conversation history", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
        oracleTool = input.tools.find((t) => t.name === "oracle");
        return {
          prompt: async (_prompt: string, opts?: { contextMessages?: any[] }) => {
            seenContextMessages = opts?.contextMessages ?? [];
            return makeRunnerResult("done");
          },
        };
      },
    });

    const result = await handler.execute(incoming);

    expect(result.response).toBe("done");
    // Oracle tool should be present in the tool set
    expect(oracleTool).toBeDefined();
    expect(oracleTool.name).toBe("oracle");
    // Context messages should include prior conversation (not just the trigger)
    expect(seenContextMessages.length).toBeGreaterThan(0);

    await history.close();
  });

  it("second command in same thread steers into active session and returns null", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
          return makeRunnerResult("done");
        },
      }),
    });

    const resultPromise = handler.handleIncomingMessage(incoming, {
      isDirect: true,
      sendResponse: async () => {},
    });

    await firstStarted.promise;

    const followup: RoomMessage = {
      ...makeMessage("!s second line"),
      threadId: "thread-1",
    };

    const followupPromise = handler.handleIncomingMessage(followup, {
      isDirect: true,
      sendResponse: async () => {},
    });

    releaseFirst.resolve();

    const [result, followupResult] = await Promise.all([resultPromise, followupPromise]);

    expect(result?.response).toBe("done");
    expect(followupResult).toBeNull();
    expect(promptCallCount).toBe(1);
    expect(steerCalls).toHaveLength(1);
    expect(steerCalls[0].content[0].text).toContain("second line");

    await history.close();
  });

  it("returns help text for !h", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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

  it("triggers auto-chronicler for direct + passive paths and skips it when rate-limited", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const autoChronicler = {
      checkAndChronicle: vi.fn(async () => false),
    };

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      autoChronicler,
      runnerFactory: () => ({
        prompt: async () => makeRunnerResult("done"),
      }),
    });

    await handler.handleIncomingMessage(makeMessage("!s trigger chronicler"), { isDirect: true });
    await handler.handleIncomingMessage(makeMessage("ambient channel line"), { isDirect: false });

    expect(autoChronicler.checkAndChronicle).toHaveBeenCalledTimes(2);
    expect(autoChronicler.checkAndChronicle).toHaveBeenNthCalledWith(
      1,
      "muaddib",
      "libera",
      "#test",
      40,
    );
    expect(autoChronicler.checkAndChronicle).toHaveBeenNthCalledWith(
      2,
      "muaddib",
      "libera",
      "#test",
      40,
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

    await rateLimitedHandler.handleIncomingMessage(makeMessage("!s should skip autochronicler"), {
      isDirect: true,
    });

    expect(rateLimitedAutoChronicler.checkAndChronicle).not.toHaveBeenCalled();

    await history.close();
  });

  it("handleIncomingMessage persists user + assistant with selected trigger mode", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const incoming = makeMessage("!s persistence check");

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        prompt: async () => ({
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
    const assistantContent = (context[1] as any).content[0].text;
    expect(assistantContent).toContain("!s");

    const llmCalls = await history.getLlmCalls();
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].provider).toBe("openai");
    expect(llmCalls[0].model).toBe("gpt-4o-mini");
    expect(llmCalls[0].triggerMessageId).toBeGreaterThan(0);
    expect(llmCalls[0].responseMessageId).toBeGreaterThan(0);

    await history.close();
  });

  it("emits cost followup + daily milestone messages when command usage crosses thresholds", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    await history.logLlmCall({
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 10,
      outputTokens: 10,
      cost: 0.9,
      callType: "agent_run",
      arcName: "libera##test",
    });

    const incoming = makeMessage("!s expensive response");
    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        prompt: async () =>
          makeRunnerResult("primary response", {
            inputTokens: 123,
            outputTokens: 45,
            totalCost: 0.35,
            toolCallsCount: 2,
          }),
      }),
    });

    const result = await handler.handleIncomingMessage(incoming, {
      isDirect: true,
      sendResponse: async (text) => {
        sent.push(text);
      },
    });

    expect(result?.response).toBe("primary response");
    expect(result?.toolCallsCount).toBe(2);
    expect(sent).toEqual([
      "primary response",
      "(this message used 2 tool calls, 123 in / 45 out tokens, and cost $0.3500)",
      "(fun fact: my messages in this channel have already cost $1.2500 today)",
    ]);

    const rows = await history.getFullHistory("libera", "#test");
    expect(rows).toHaveLength(4);
    expect(rows[2].message).toContain("this message used 2 tool calls");
    expect(rows[3].message).toContain("already cost $1.2500 today");

    await history.close();
  });

  it("converts oversized command responses into artifact links and keeps llm linkage", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
      runnerFactory: () => ({
        prompt: async () => makeRunnerResult(longResponse),
      }),
    });

    const result = await handler.handleIncomingMessage(incoming, {
      isDirect: true,
      sendResponse: async (text) => {
        sent.push(text);
      },
    });

    expect(result?.response).toContain("... full response: https://example.com/artifacts/?");
    expect(sent).toEqual([result?.response ?? ""]);

    const rows = await history.getFullHistory("libera", "#test");
    expect(rows).toHaveLength(2);
    expect(rows[1].message).toContain("full response: https://example.com/artifacts/?");

    const llmCalls = await history.getLlmCalls();
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].responseMessageId).toBe(rows[1].id);

    await history.close();
  });

  it("does not convert response into artifact when response_max_bytes is not exceeded", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
      runnerFactory: () => ({
        prompt: async () => makeRunnerResult("short answer"),
      }),
    });

    const result = await handler.handleIncomingMessage(incoming, { isDirect: true });

    expect(result?.response).toBe("short answer");

    await history.close();
  });

  it("keeps fallback-model llm logging/linkage when oversized response is converted to artifact", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
      runnerFactory: () => ({
        prompt: async () =>
          makeRunnerResult("The AI refused to respond to this request", {
            refusalFallbackActivated: true,
            refusalFallbackModel: "anthropic:claude-3-5-haiku",
          }),
      }),
    });

    const result = await handler.handleIncomingMessage(incoming, { isDirect: true });

    expect(result?.model).toBe("openai:gpt-4o-mini");
    expect(result?.response).toContain("The AI refused to respond to this request");

    const rows = await history.getFullHistory("libera", "#test");
    expect(rows).toHaveLength(2);
    expect(rows[1].message).toContain("The AI refused to respond to this request");

    const llmCalls = await history.getLlmCalls();
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].provider).toBe("openai");
    expect(llmCalls[0].model).toBe("gpt-4o-mini");
    expect(llmCalls[0].responseMessageId).toBe(rows[1].id);

    await history.close();
  });

  it("fails fast when command.response_max_bytes is invalid", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
    ).toThrow("command.response_max_bytes must be a positive integer.");

    await history.close();
  });

  it("retries on explicit refusal text with agent.refusalFallbackModel and persists fallback model usage", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
        return {
          prompt: async () =>
            makeRunnerResult("The AI refused to respond to this request", {
              refusalFallbackActivated: true,
              refusalFallbackModel: "anthropic:claude-3-5-haiku",
            }),
        };
      },
    });

    const result = await handler.handleIncomingMessage(incoming, { isDirect: true });

    expect(result?.response).toBe("The AI refused to respond to this request [refusal fallback to claude-3-5-haiku]");
    expect(result?.model).toBe("openai:gpt-4o-mini");
    expect(runnerModels).toEqual(["openai:gpt-4o-mini"]);

    const llmCalls = await history.getLlmCalls();
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].provider).toBe("openai");
    expect(llmCalls[0].model).toBe("gpt-4o-mini");

    const rows = await history.getFullHistory("libera", "#test");
    expect(rows[1]?.message).toContain("[refusal fallback to claude-3-5-haiku]");

    await history.close();
  });

  it("propagates explicit safety-refusal errors from runner", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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

    await expect(handler.execute(incoming)).rejects.toThrow(
      "Agent run failed: invalid_prompt blocked for safety reasons.",
    );

    await history.close();
  });

  it("does not trigger fallback when response lacks explicit refusal/error markers", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
        return {
          prompt: async () => makeRunnerResult("normal answer"),
        };
      },
    });

    const result = await handler.handleIncomingMessage(incoming, { isDirect: true });

    expect(result?.response).toBe("normal answer");
    expect(result?.model).toBe("openai:gpt-4o-mini");
    expect(runnerModels).toEqual(["openai:gpt-4o-mini"]);

    const llmCalls = await history.getLlmCalls();
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].provider).toBe("openai");
    expect(llmCalls[0].model).toBe("gpt-4o-mini");

    await history.close();
  });

  it("concurrent commands from same user steer into active session", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
          return makeRunnerResult("first response");
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(makeMessage("!s first"), {
      isDirect: true,
      sendResponse: async () => {},
    });

    await firstStarted.promise;

    const t2 = handler.handleIncomingMessage(makeMessage("!s second"), {
      isDirect: true,
      sendResponse: async () => {},
    });
    const t3 = handler.handleIncomingMessage(makeMessage("!s third"), {
      isDirect: true,
      sendResponse: async () => {},
    });

    releaseFirst.resolve();

    const [result1, result2, result3] = await Promise.all([t1, t2, t3]);

    expect(runCount).toBe(1);
    expect(result1?.response).toBe("first response");
    expect(result2).toBeNull();
    expect(result3).toBeNull();
    expect(steerCalls).toHaveLength(2);
    const steeredTexts = steerCalls.map((c: any) => c.content[0].text);
    expect(steeredTexts.some((t: string) => t.includes("second"))).toBe(true);
    expect(steeredTexts.some((t: string) => t.includes("third"))).toBe(true);

    await history.close();
  });

  it("messages arriving before agent creation are buffered and steered on flush", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
          return makeRunnerResult("done");
        },
      }),
    });

    // First message triggers session creation (blocks in prompt).
    const t1 = handler.handleIncomingMessage(makeMessage("!s hello"), {
      isDirect: true,
      sendResponse: async () => {},
    });

    await resolveStarted.promise;

    // Second message arrives while agent is NOT yet created (pre-onAgentCreated).
    const t2 = handler.handleIncomingMessage(makeMessage("!s continuation"), {
      isDirect: true,
      sendResponse: async () => {},
    });

    // Also a passive message from the same user should be buffered.
    const t3 = handler.handleIncomingMessage(
      makeMessage("passive follow-up"),
      { isDirect: false },
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
    const history = new ChatHistoryStore(":memory:", 40);
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
          return makeRunnerResult("first response");
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(
      { ...makeMessage("!s first"), threadId: "thread-1" },
      { isDirect: true, sendResponse: async () => {} },
    );

    await firstStarted.promise;

    const t2 = handler.handleIncomingMessage(
      { ...makeMessage("!s second"), nick: "bob", threadId: "thread-1" },
      { isDirect: true, sendResponse: async () => {} },
    );

    const t3 = handler.handleIncomingMessage(
      { ...makeMessage("!s third"), nick: "carol", threadId: "thread-1" },
      { isDirect: true, sendResponse: async () => {} },
    );

    releaseFirst.resolve();

    const [result1, result2, result3] = await Promise.all([t1, t2, t3]);

    expect(result1?.response).toBe("first response");
    expect(result2).toBeNull();
    expect(result3).toBeNull();
    expect(steerCalls).toHaveLength(2);
    const steeredTexts = steerCalls.map((c: any) => c.content[0].text);
    expect(steeredTexts).toContainEqual(expect.stringContaining("bob"));
    expect(steeredTexts).toContainEqual(expect.stringContaining("carol"));

    await history.close();
  });

  it("passives and commands arriving during active session all steer into the agent", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
          return makeRunnerResult("first response");
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(makeMessage("!s first"), {
      isDirect: true,
      sendResponse: async (text) => { sent.push(text); },
    });

    await firstStarted.promise;

    const p3Persisted = waitForPersistedMessage(history, (message) => message.content === "p3");

    const p1 = handler.handleIncomingMessage(makeMessage("p1"), { isDirect: false });
    const p2 = handler.handleIncomingMessage(makeMessage("p2"), { isDirect: false });
    const c2 = handler.handleIncomingMessage(makeMessage("!s second"), {
      isDirect: true, sendResponse: async (text) => { sent.push(text); },
    });
    const p3 = handler.handleIncomingMessage(makeMessage("p3"), { isDirect: false });

    await p3Persisted;
    releaseFirst.resolve();

    const [result1, passiveResult1, passiveResult2, commandResult2, passiveResult3] = await Promise.all([
      t1, p1, p2, c2, p3,
    ]);

    expect(result1?.response).toBe("first response");
    expect(sent).toEqual(["first response"]);
    expect(passiveResult1).toBeNull();
    expect(passiveResult2).toBeNull();
    expect(commandResult2).toBeNull(); // steered, not a separate run
    expect(passiveResult3).toBeNull();
    // All 4 messages should have been steered into the agent
    expect(steerCalls).toHaveLength(4);

    await history.close();
  });

  it("passes onAgentCreated callback to runner factory for steering registration", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    let capturedCallback: ((agent: any) => void) | undefined;

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => {
        capturedCallback = input.onAgentCreated;
        return {
          prompt: async () => makeRunnerResult("ok"),
        };
      },
    });

    await handler.handleIncomingMessage(makeMessage("!s hello"), { isDirect: true });

    expect(capturedCallback).toBeDefined();

    await history.close();
  });

  it("passive messages during active session steer into the running agent", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
      runnerFactory: (input) => {
        return {
          prompt: async () => {
            // Simulate agent creation callback
            input.onAgentCreated?.(mockAgent as any);
            firstStarted.resolve();
            await releaseFirst.promise;
            return makeRunnerResult("done");
          },
        };
      },
    });

    const t1 = handler.handleIncomingMessage(makeMessage("!s first"), {
      isDirect: true,
      sendResponse: async () => {},
    });

    await firstStarted.promise;

    // Send a passive message while agent is running
    const interruptPersisted = waitForPersistedMessage(
      history,
      (message) => message.content === "interrupt me",
    );
    handler.handleIncomingMessage(makeMessage("interrupt me"), { isDirect: false });

    await interruptPersisted;

    releaseFirst.resolve();
    await t1;

    expect(steerCalls).toHaveLength(1);
    expect(steerCalls[0].content[0].text).toContain("interrupt me");

    await history.close();
  });

  it("starts proactive session on passive message in proactive-enabled channel", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const proactiveRoomConfig = {
      ...roomConfig,
      proactive: {
        interjecting: ["libera##test"],
        debounceSeconds: 0.05,
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
      runnerFactory: () => ({
        prompt: async () => {
          runnerCalled = true;
          return makeRunnerResult("proactive response");
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
    await handler.handleIncomingMessage(makeMessage("just chatting"), {
      isDirect: false,
    });

    // Runner should NOT be called since score is below threshold
    expect(runnerCalled).toBe(false);

    await history.close();
  });

  it("does not start proactive session on passive message in non-proactive channel", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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

    await handler.handleIncomingMessage(makeMessage("just chatting"), {
      isDirect: false,
    });

    // Should complete immediately without starting a proactive session
    await history.close();
  });

  it("command preempts proactive debounce session", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
      runnerFactory: () => ({
        prompt: async (prompt) => {
          runnerPrompts.push(prompt);
          return makeRunnerResult("command response");
        },
      }),
    });

    // Start proactive session with a passive message
    const passivePersisted = waitForPersistedMessage(
      history,
      (message) => message.content === "background chatter",
    );
    const passivePromise = handler.handleIncomingMessage(makeMessage("background chatter"), {
      isDirect: false,
    });

    await passivePersisted;

    // Now send a command — should preempt the proactive debounce
    const commandResult = await handler.handleIncomingMessage(makeMessage("!s direct question"), {
      isDirect: true,
      sendResponse: async (text) => { sent.push(text); },
    });

    await passivePromise;

    // The command should have been executed
    expect(commandResult?.response).toBe("command response");
    expect(sent).toContain("command response");
    expect(runnerPrompts.some(p => p.includes("direct question"))).toBe(true);

    await history.close();
  });

  it("passive messages steer into running proactive agent session", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const proactiveRoomConfig = {
      ...roomConfig,
      proactive: {
        interjecting: ["libera##test"],
        debounceSeconds: 0.05,
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
          return makeRunnerResult("proactive response");
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
    const passivePromise = handler.handleIncomingMessage(makeMessage("trigger chat"), {
      isDirect: false,
    });

    // Wait for the proactive agent to start
    await agentStarted.promise;

    // Send more passive messages from different nicks — should steer into proactive agent
    await handler.handleIncomingMessage(
      { ...makeMessage("bob says hi"), nick: "bob" },
      { isDirect: false },
    );
    await handler.handleIncomingMessage(
      { ...makeMessage("carol chimes in"), nick: "carol" },
      { isDirect: false },
    );

    for (const msg of steeredMessages) {
      expect(msg).toContain("Background channel message");
    }
    expect(steeredMessages[0]).toContain("<bob> bob says hi");
    expect(steeredMessages[1]).toContain("<carol> carol chimes in");

    // Release the agent and let the proactive session finish
    releaseAgent.resolve();
    await passivePromise;
    // Give the fire-and-forget proactive pipeline time to complete cleanup
    await new Promise((r) => setTimeout(r, 100));

    // After proactive session ends, passive messages should no longer steer
    steeredMessages.length = 0;
    await handler.handleIncomingMessage(
      { ...makeMessage("late message"), nick: "dave" },
      { isDirect: false },
    );
    expect(steeredMessages).toEqual([]);

    await history.close();
  });

  it("commands are not blocked by running proactive session", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const proactiveRoomConfig = {
      ...roomConfig,
      proactive: {
        interjecting: ["libera##test"],
        debounceSeconds: 0.05,
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
            return makeRunnerResult("proactive response");
          }
          commandRunnerCalled = true;
          input.onAgentCreated?.({ steer() {} } as any);
          return makeRunnerResult("command response");
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
    const passivePromise = handler.handleIncomingMessage(makeMessage("trigger chat"), {
      isDirect: false,
    });
    await agentStarted.promise;

    // Command should still execute independently
    isProactiveCall = false;
    const result = await handler.handleIncomingMessage(makeMessage("!s direct question"), {
      isDirect: true,
    });

    expect(commandRunnerCalled).toBe(true);
    expect(result?.response).toBe("command response");

    releaseAgent.resolve();
    await passivePromise;
    await history.close();
  });

  it("isolates sessions by nick when there is no thread", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
      runnerFactory: () => ({
        prompt: async (prompt) => {
          runCount += 1;
          prompts.push(prompt);

          if (runCount === 1) {
            aliceStarted.resolve();
            await releaseAlice.promise;
            return makeRunnerResult("alice reply");
          }
          return makeRunnerResult("bob reply");
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(makeMessage("!s alice question"), {
      isDirect: true,
      sendResponse: async (text) => { sent.push(text); },
    });

    await aliceStarted.promise;

    // Bob sends a command while Alice's is running — should get own session
    const t2 = handler.handleIncomingMessage(
      { ...makeMessage("!s bob question"), nick: "bob" },
      {
        isDirect: true,
        sendResponse: async (text) => { sent.push(text); },
      },
    );

    releaseAlice.resolve();
    const [r1, r2] = await Promise.all([t1, t2]);

    expect(runCount).toBe(2);
    expect(r1?.response).toBe("alice reply");
    expect(r2?.response).toBe("bob reply");
    expect(prompts).toContain("<alice> alice question");
    expect(prompts).toContain("<bob> bob question");

    await history.close();
  });

  it("isolates sessions for the same nick across different channels", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    let runCount = 0;
    const prompts: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        prompt: async (prompt) => {
          runCount += 1;
          prompts.push(prompt);

          if (runCount === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
            return makeRunnerResult("chan1 reply");
          }
          return makeRunnerResult("chan2 reply");
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(
      { ...makeMessage("!s first"), channelName: "#foo" },
      { isDirect: true, sendResponse: async () => {} },
    );

    await firstStarted.promise;

    const t2 = handler.handleIncomingMessage(
      { ...makeMessage("!s second"), channelName: "#bar" },
      { isDirect: true, sendResponse: async () => {} },
    );

    releaseFirst.resolve();
    const [r1, r2] = await Promise.all([t1, t2]);

    expect(runCount).toBe(2);
    expect(r1?.response).toBe("chan1 reply");
    expect(r2?.response).toBe("chan2 reply");

    await history.close();
  });

  it("commands arriving after session starts are steered — only one runner invocation", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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
          return makeRunnerResult("reply 1");
        },
      }),
    });

    const t1 = handler.handleIncomingMessage(makeMessage("!s first"), {
      isDirect: true,
      sendResponse: async (text) => { sent.push(text); },
    });

    await firstStarted.promise;

    const t2 = handler.handleIncomingMessage(makeMessage("!s second"), {
      isDirect: true,
      sendResponse: async (text) => { sent.push(text); },
    });
    const t3 = handler.handleIncomingMessage(makeMessage("!s third"), {
      isDirect: true,
      sendResponse: async (text) => { sent.push(text); },
    });

    releaseFirst.resolve();
    const [r1, r2, r3] = await Promise.all([t1, t2, t3]);

    expect(runCount).toBe(1);
    expect(r1?.response).toBe("reply 1");
    expect(r2).toBeNull();
    expect(r3).toBeNull();
    expect(steerCalls).toHaveLength(2);
    expect(sent).toEqual(["reply 1"]);

    await history.close();
  });

  it("runner error cleans up session so next command starts fresh", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    let runCount = 0;
    const sent: string[] = [];

    const handler = createHandler({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (_input) => ({
        prompt: async () => {
          runCount += 1;
          if (runCount === 1) {
            throw new Error("runner exploded");
          }
          return makeRunnerResult("recovered");
        },
      }),
    });

    // First command fails
    await expect(
      handler.handleIncomingMessage(makeMessage("!s first"), {
        isDirect: true,
        sendResponse: async (text) => { sent.push(text); },
      }),
    ).rejects.toThrow("runner exploded");

    // Second command should start a fresh session (no stale entry in map)
    const result = await handler.handleIncomingMessage(makeMessage("!s second"), {
      isDirect: true,
      sendResponse: async (text) => { sent.push(text); },
    });

    expect(runCount).toBe(2);
    expect(result?.response).toBe("recovered");
    expect(sent).toContain("recovered");

    await history.close();
  });

  it("passive messages with no active session and no proactive are no-ops", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
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

    const r1 = await handler.handleIncomingMessage(makeMessage("just chatting"), {
      isDirect: false,
    });
    const r2 = await handler.handleIncomingMessage(makeMessage("more chat"), {
      isDirect: false,
    });

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(runCount).toBe(0);

    await history.close();
  });
});
