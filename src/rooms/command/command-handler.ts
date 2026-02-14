/**
 * Command handler — session lifecycle coordinator.
 *
 * Owns the steering queue, proactive interjection lifecycle, and dispatch
 * between command/passive message paths.  Delegates actual command execution
 * to CommandExecutor.
 */

import { SessionRunner } from "../../agent/session-runner.js";
import {
  createDefaultToolExecutors,
  type BaselineToolOptions,
} from "../../agent/tools/baseline-tools.js";
import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import type { MuaddibRuntime } from "../../runtime.js";
import { createModeClassifier } from "./classifier.js";
import { RateLimiter } from "./rate-limiter.js";
import { ContextReducerTs } from "./context-reducer.js";
import {
  SteeringQueue,
  type QueuedInboundMessage,
  type SteeringKey,
} from "./steering-queue.js";
import {
  CommandResolver,
  type CommandConfig,
} from "./resolver.js";
import {
  evaluateProactiveInterjection,
  type ProactiveConfig,
} from "./proactive.js";
import {
  CommandExecutor,
  type CommandExecutionResult,
  type CommandRunnerFactory,
  type CommandRunnerFactoryInput,
  type CommandRateLimiter,
  type CommandExecutorLogger,
  type SteeringContextDrainer,
  numberWithDefault,
  pickModeModel,
  parseResponseMaxBytes,
  resolveConfigModelSpec,
  modelStrCore,
} from "./command-executor.js";
import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import type { RoomMessage } from "../message.js";
import type { ProactiveRoomConfig } from "../../config/muaddib-config.js";

// Re-export types that external consumers depend on
export type {
  CommandExecutionResult,
  CommandRunnerFactory,
  CommandRunnerFactoryInput,
  CommandRateLimiter,
  CommandExecutorLogger as CommandHandlerLogger,
  SteeringContextDrainer,
} from "./command-executor.js";
export type { CommandRunner } from "./command-executor.js";

export interface CommandHandlerRoomConfig {
  command: CommandConfig;
  proactive?: ProactiveRoomConfig;
  prompt_vars?: Record<string, string>;
}

export interface RoomCommandHandlerOverrides {
  responseCleaner?: (text: string, nick: string) => string;
  runnerFactory?: CommandRunnerFactory;
  rateLimiter?: CommandRateLimiter;
  contextReducer?: { isConfigured: boolean; reduce(context: Array<{ role: string; content: string }>, systemPrompt: string): Promise<Array<{ role: string; content: string }>> };
  onProgressReport?: (text: string) => void | Promise<void>;
}

export interface HandleIncomingMessageOptions {
  isDirect: boolean;
  sendResponse?: (text: string) => Promise<void>;
}

/**
 * Shared TS command execution path with proactive interjection support.
 *
 * Proactive interjection is integrated into the steering queue: passive messages
 * in proactive-enabled channels start a steering session with a debounce-until-
 * silence loop.  Commands arriving during the debounce or during agent execution
 * are handled via the normal steering mechanism (queued and drained mid-flight).
 */
export class RoomCommandHandlerTs {
  readonly resolver: CommandResolver;
  private readonly executor: CommandExecutor;
  private readonly commandConfig: CommandConfig;
  private readonly steeringQueue: SteeringQueue;
  private readonly proactiveRateLimiter: CommandRateLimiter | null;
  private readonly proactiveConfig: ProactiveConfig | null;
  private readonly proactiveChannels: Set<string>;
  private readonly modelAdapter: PiAiModelAdapter;
  private readonly classifyMode: (context: Array<{ role: string; content: string }>) => Promise<string>;
  private readonly history: ChatHistoryStore;
  private readonly getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  private readonly logger: CommandExecutorLogger;

  constructor(
    runtime: MuaddibRuntime,
    roomName: string,
    overrides?: RoomCommandHandlerOverrides,
  ) {
    const roomConfig = runtime.config.getRoomConfig(roomName);
    if (!roomConfig.command) {
      throw new Error(`rooms.${roomName}.command is missing.`);
    }

    const commandConfig = roomConfig.command;
    const actorConfig = runtime.config.getActorConfig();
    const toolsConfig = runtime.config.getToolsConfig();
    const contextReducerConfig = runtime.config.getContextReducerConfig();
    const providersConfig = runtime.config.getProvidersConfig();
    const loggerInstance = runtime.logger.getLogger(`muaddib.rooms.command.${roomName}`);

    this.commandConfig = commandConfig;
    this.logger = loggerInstance;
    this.history = runtime.history;
    this.getApiKey = runtime.getApiKey;
    this.modelAdapter = runtime.modelAdapter ?? new PiAiModelAdapter();

    this.classifyMode = createModeClassifier(commandConfig, {
      getApiKey: runtime.getApiKey,
      modelAdapter: runtime.modelAdapter,
      logger: loggerInstance,
    });

    const refusalFallbackModel = resolveConfigModelSpec(
      runtime.config.getRouterConfig().refusalFallbackModel,
      "router.refusal_fallback_model",
      this.modelAdapter,
    );
    const persistenceSummaryModel = resolveConfigModelSpec(
      runtime.config.getToolsConfig().summary?.model,
      "tools.summary.model",
      this.modelAdapter,
    );

    this.resolver = new CommandResolver(
      commandConfig,
      this.classifyMode,
      "!h",
      new Set(["!c"]),
      modelStrCore,
    );

    const runnerFactory: CommandRunnerFactory =
      overrides?.runnerFactory ??
      ((input: CommandRunnerFactoryInput) =>
        new SessionRunner({
          model: input.model,
          systemPrompt: input.systemPrompt,
          tools: input.tools,
          modelAdapter: this.modelAdapter,
          getApiKey: runtime.getApiKey,
          maxIterations: actorConfig.maxIterations,

          llmDebugMaxChars: actorConfig.llmDebugMaxChars,
          logger: input.logger,
          steeringMessageProvider: input.steeringMessageProvider,
        }));

    const rateLimiter: CommandRateLimiter =
      overrides?.rateLimiter ??
      new RateLimiter(
        numberWithDefault(commandConfig.rate_limit, 30),
        numberWithDefault(commandConfig.rate_period, 900),
      );

    const defaultExecutors = createDefaultToolExecutors(
      (overrides as any)?.toolOptions ?? {
        spritesToken: toolsConfig.sprites?.token,
        jinaApiKey: toolsConfig.jina?.apiKey,
        artifactsPath: toolsConfig.artifacts?.path,
        artifactsUrl: toolsConfig.artifacts?.url,
        getApiKey: runtime.getApiKey,
        logger: loggerInstance,
        oracleModel: toolsConfig.oracle?.model,
        oraclePrompt: toolsConfig.oracle?.prompt,
        imageGenModel: toolsConfig.imageGen?.model,
        openRouterBaseUrl: providersConfig.openrouter?.baseUrl,
        chronicleStore: runtime.chronicleStore,
        chronicleLifecycle: runtime.chronicleLifecycle,
      } satisfies Omit<BaselineToolOptions, "onProgressReport">,
    );

    const toolOptions: Omit<BaselineToolOptions, "onProgressReport"> = {
      spritesToken: toolsConfig.sprites?.token,
      jinaApiKey: toolsConfig.jina?.apiKey,
      artifactsPath: toolsConfig.artifacts?.path,
      artifactsUrl: toolsConfig.artifacts?.url,
      getApiKey: runtime.getApiKey,
      logger: loggerInstance,
      oracleModel: toolsConfig.oracle?.model,
      oraclePrompt: toolsConfig.oracle?.prompt,
      imageGenModel: toolsConfig.imageGen?.model,
      openRouterBaseUrl: providersConfig.openrouter?.baseUrl,
      chronicleStore: runtime.chronicleStore,
      chronicleLifecycle: runtime.chronicleLifecycle,
    };

    this.executor = new CommandExecutor({
      commandConfig,
      promptVars: roomConfig.prompt_vars,
      history: runtime.history,
      resolver: this.resolver,
      runnerFactory,
      rateLimiter,
      modelAdapter: this.modelAdapter,
      contextReducer:
        overrides?.contextReducer ??
        new ContextReducerTs({
          config: contextReducerConfig,
          modelAdapter: this.modelAdapter,
          getApiKey: runtime.getApiKey,
          logger: loggerInstance,
        }),
      autoChronicler: runtime.autoChronicler ?? null,
      chronicleStore: runtime.chronicleStore ?? null,
      logger: loggerInstance,
      getApiKey: runtime.getApiKey,
      refusalFallbackModel: refusalFallbackModel ?? null,
      persistenceSummaryModel: persistenceSummaryModel ?? null,
      responseMaxBytes: parseResponseMaxBytes(commandConfig.response_max_bytes),
      shareArtifact:
        (overrides as any)?.toolOptions?.executors?.shareArtifact ?? defaultExecutors.shareArtifact,
      responseCleaner: overrides?.responseCleaner,
      onProgressReport: overrides?.onProgressReport,
      toolOptions,
    });

    this.steeringQueue = new SteeringQueue();

    // Proactive interjection setup
    const rawProactive = roomConfig.proactive;
    const interjecting = rawProactive?.interjecting;
    if (rawProactive && interjecting && interjecting.length > 0) {
      this.proactiveConfig = {
        interjecting,
        debounce_seconds: rawProactive.debounce_seconds ?? 15,
        history_size: rawProactive.history_size ?? commandConfig.history_size,
        rate_limit: rawProactive.rate_limit ?? 10,
        rate_period: rawProactive.rate_period ?? 3600,
        interject_threshold: rawProactive.interject_threshold ?? 7,
        models: {
          validation: rawProactive.models?.validation ?? [],
          serious: rawProactive.models?.serious ?? pickModeModel(commandConfig.modes.serious?.model) ?? "",
        },
        prompts: {
          interject: rawProactive.prompts?.interject ?? "",
          serious_extra: rawProactive.prompts?.serious_extra ?? "",
        },
      };
      this.proactiveChannels = new Set(interjecting);
      this.proactiveRateLimiter = new RateLimiter(
        this.proactiveConfig.rate_limit,
        this.proactiveConfig.rate_period,
      );
    } else {
      this.proactiveConfig = null;
      this.proactiveChannels = new Set();
      this.proactiveRateLimiter = null;
    }
  }

  shouldIgnoreUser(nick: string): boolean {
    const ignoreUsers = this.commandConfig.ignore_users ?? [];
    return ignoreUsers.some((ignored) => String(ignored).toLowerCase() === nick.toLowerCase());
  }

  async handleIncomingMessage(
    message: RoomMessage,
    options: HandleIncomingMessageOptions,
  ): Promise<CommandExecutionResult | null> {
    const triggerMessageId = await this.history.addMessage(message);

    if (!options.isDirect) {
      this.logger.debug(
        "Handling passive message",
        `arc=${message.serverTag}#${message.channelName}`,
        `nick=${message.nick}`,
      );
      await this.handlePassiveMessage(message, options.sendResponse);
      return null;
    }

    this.logger.debug(
      "Handling direct command",
      `arc=${message.serverTag}#${message.channelName}`,
      `nick=${message.nick}`,
    );

    if (this.resolver.shouldBypassSteeringQueue(message)) {
      return this.executor.execute(
        message,
        triggerMessageId,
        options.sendResponse,
        this.createSteeringContextDrainer(SteeringQueue.keyForMessage(message)),
      );
    }

    return this.handleCommandMessage(message, triggerMessageId, options.sendResponse);
  }

  /** Direct execution without steering queue (for CLI / tests). */
  async execute(message: RoomMessage): Promise<CommandExecutionResult> {
    return this.executor.execute(
      message,
      0, // no trigger message id for direct execution
      undefined,
      this.createSteeringContextDrainer(SteeringQueue.keyForMessage(message)),
    );
  }

  /** Expose buildSystemPrompt for tests. */
  buildSystemPrompt(mode: string, mynick: string, modelOverride?: string): string {
    return this.executor.buildSystemPrompt(mode, mynick, modelOverride);
  }

  // ── Session lifecycle: commands ──

  private async handleCommandMessage(
    message: RoomMessage,
    triggerMessageId: number,
    sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<CommandExecutionResult | null> {
    const {
      isRunner,
      steeringKey,
      item: runnerItem,
    } = this.steeringQueue.enqueueCommandOrStartRunner(message, triggerMessageId, sendResponse);

    if (!isRunner) {
      await runnerItem.completion;
      return (runnerItem.result as CommandExecutionResult | null) ?? null;
    }

    try {
      if (runnerItem.triggerMessageId === null) {
        throw new Error("Runner command item is missing trigger message id.");
      }

      runnerItem.result = await this.executor.execute(
        runnerItem.message,
        runnerItem.triggerMessageId,
        runnerItem.sendResponse,
        this.createSteeringContextDrainer(steeringKey),
      );

      this.steeringQueue.finishItem(runnerItem);
      await this.drainRemainingSessionItems(steeringKey);
    } catch (error) {
      this.steeringQueue.abortSession(steeringKey, error);
      this.steeringQueue.failItem(runnerItem, error);
      throw error;
    }

    return (runnerItem.result as CommandExecutionResult | null) ?? null;
  }

  // ── Session lifecycle: passives ──

  private async handlePassiveMessage(
    message: RoomMessage,
    sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<void> {
    const channelKey = CommandResolver.channelKey(message.serverTag, message.channelName);
    const startProactive = this.proactiveChannels.has(channelKey);

    const { queued, isProactiveRunner, steeringKey, item } =
      this.steeringQueue.enqueuePassive(message, sendResponse, startProactive);

    if (queued) {
      await item.completion;
      return;
    }

    if (isProactiveRunner) {
      this.runProactiveSession(steeringKey, item).catch((error) => {
        this.logger.error("Proactive session failed", error);
      });
      await item.completion;
      return;
    }

    await this.handlePassiveMessageCore(message, sendResponse);
  }

  private async handlePassiveMessageCore(
    message: RoomMessage,
    _sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<void> {
    await this.executor.triggerAutoChronicler(message, this.commandConfig.history_size);
  }

  // ── Proactive interjection lifecycle ──

  private async runProactiveSession(
    steeringKey: SteeringKey,
    triggerItem: QueuedInboundMessage,
  ): Promise<void> {
    if (!this.proactiveConfig) {
      this.steeringQueue.finishItem(triggerItem);
      this.steeringQueue.closeSession(steeringKey);
      return;
    }

    const debounceMs = this.proactiveConfig.debounce_seconds * 1000;
    this.steeringQueue.finishItem(triggerItem);

    let activeItem: QueuedInboundMessage | null = null;

    try {
      // ── Debounce loop: wait for silence ──
      while (true) {
        const result = await this.steeringQueue.waitForNewItem(steeringKey, debounceMs);

        if (result === "timeout") {
          break;
        }

        if (this.steeringQueue.hasQueuedCommands(steeringKey)) {
          break;
        }

        this.steeringQueue.drainSteeringContextMessages(steeringKey);
      }

      // ── Take next work item via compaction ──
      const { dropped, nextItem } = this.steeringQueue.takeNextWorkCompacted(steeringKey);
      for (const droppedItem of dropped) {
        droppedItem.result = null;
        this.steeringQueue.finishItem(droppedItem);
      }

      if (!nextItem) {
        await this.evaluateAndMaybeInterject(steeringKey, triggerItem.message, triggerItem.sendResponse);
        return;
      }

      activeItem = nextItem;

      if (activeItem.kind === "command") {
        if (activeItem.triggerMessageId === null) {
          throw new Error("Queued command item is missing trigger message id.");
        }
        activeItem.result = await this.executor.execute(
          activeItem.message,
          activeItem.triggerMessageId,
          activeItem.sendResponse,
          this.createSteeringContextDrainer(steeringKey),
        );
      } else {
        await this.evaluateAndMaybeInterject(steeringKey, activeItem.message, activeItem.sendResponse);
        activeItem.result = null;
      }

      this.steeringQueue.finishItem(activeItem);
      await this.drainRemainingSessionItems(steeringKey);
    } catch (error) {
      this.steeringQueue.abortSession(steeringKey, error);
      if (activeItem) {
        this.steeringQueue.failItem(activeItem, error);
      }
      throw error;
    }
  }

  private async evaluateAndMaybeInterject(
    steeringKey: SteeringKey,
    message: RoomMessage,
    sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<void> {
    if (!this.proactiveConfig || !this.proactiveRateLimiter) {
      return;
    }

    if (!this.proactiveRateLimiter.checkLimit()) {
      this.logger.debug(
        "Proactive interjection rate limited",
        `arc=${message.serverTag}#${message.channelName}`,
        `nick=${message.nick}`,
      );
      return;
    }

    const context = await this.history.getContextForMessage(
      message,
      this.proactiveConfig.history_size,
    );

    const evalResult = await evaluateProactiveInterjection(
      this.proactiveConfig,
      context,
      {
        modelAdapter: this.modelAdapter,
        getApiKey: this.getApiKey,
        logger: this.logger,
      },
    );

    if (!evalResult.shouldInterject) {
      this.logger.debug(
        "Proactive interjection declined",
        `arc=${message.serverTag}#${message.channelName}`,
        `reason=${evalResult.reason}`,
      );
      return;
    }

    const classifiedLabel = await this.classifyMode(context);
    const classifiedTrigger = this.resolver.triggerForLabel(classifiedLabel);
    const [classifiedModeKey, classifiedRuntime] = this.resolver.runtimeForTrigger(classifiedTrigger);

    if (classifiedModeKey !== "serious") {
      this.logger.warn(
        "Proactive interjection suggested but not serious mode",
        `label=${classifiedLabel}`,
        `trigger=${classifiedTrigger}`,
        `reason=${evalResult.reason}`,
      );
      return;
    }

    this.logger.info(
      "Interjecting proactively",
      `arc=${message.serverTag}#${message.channelName}`,
      `nick=${message.nick}`,
      `message=${message.content.slice(0, 150)}`,
      `reason=${evalResult.reason}`,
    );

    await this.executor.executeProactive(
      message,
      sendResponse,
      this.proactiveConfig,
      classifiedTrigger,
      classifiedRuntime,
      this.createSteeringContextDrainer(steeringKey),
    );
  }

  // ── Shared session drain loop ──

  private async drainRemainingSessionItems(steeringKey: SteeringKey): Promise<void> {
    while (true) {
      const { dropped, nextItem } = this.steeringQueue.takeNextWorkCompacted(steeringKey);
      for (const droppedItem of dropped) {
        droppedItem.result = null;
        this.steeringQueue.finishItem(droppedItem);
      }

      if (!nextItem) {
        return;
      }

      if (nextItem.kind === "command") {
        if (nextItem.triggerMessageId === null) {
          throw new Error("Queued command item is missing trigger message id.");
        }
        nextItem.result = await this.executor.execute(
          nextItem.message,
          nextItem.triggerMessageId,
          nextItem.sendResponse,
          this.createSteeringContextDrainer(steeringKey),
        );
      } else {
        await this.handlePassiveMessageCore(nextItem.message, nextItem.sendResponse);
        nextItem.result = null;
      }

      this.steeringQueue.finishItem(nextItem);
    }
  }

  // ── Helpers ──

  private createSteeringContextDrainer(steeringKey: SteeringKey): SteeringContextDrainer {
    return () =>
      this.steeringQueue.drainSteeringContextMessages(steeringKey).map((msg) => ({
        role: "user",
        content: msg.content,
      }));
  }
}
