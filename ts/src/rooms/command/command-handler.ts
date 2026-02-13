import type { AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Usage } from "@mariozechner/pi-ai";

import {
  MuaddibAgentRunner,
  type MuaddibAgentRunnerOptions,
  type RunnerContextMessage,
  type SingleTurnResult,
} from "../../agent/muaddib-agent-runner.js";
import type { ChronicleStore } from "../../chronicle/chronicle-store.js";
import {
  createBaselineAgentTools,
  type BaselineToolOptions,
} from "../../agent/tools/baseline-tools.js";
import { createDefaultToolExecutors } from "../../agent/tools/core-executors.js";
import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import { parseModelSpec } from "../../models/model-spec.js";
import type { AutoChronicler } from "../autochronicler.js";
import { RateLimiter } from "./rate-limiter.js";
import {
  ContextReducerTs,
  type ContextReducer,
  type ContextReducerConfig,
} from "./context-reducer.js";
import type { RoomMessage } from "../message.js";
import {
  SteeringQueue,
  type QueuedInboundMessage,
  type SteeringKey,
} from "./steering-queue.js";
import {
  CommandResolver,
  type CommandConfig,
  type ResolvedCommand,
} from "./resolver.js";
import { createConsoleLogger } from "../../app/logging.js";

export interface CommandHandlerRoomConfig {
  command: CommandConfig;
  prompt_vars?: Record<string, string>;
}

export interface CommandRunner {
  runSingleTurn(
    prompt: string,
    options?: {
      contextMessages?: RunnerContextMessage[];
      thinkingLevel?: ThinkingLevel;
      persistenceSummaryModel?: string;
      onPersistenceSummary?: (text: string) => void | Promise<void>;
      visionFallbackModel?: string;
    },
  ): Promise<SingleTurnResult>;
}

export interface CommandRunnerFactoryInput {
  model: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  logger?: {
    debug(message: string, ...data: unknown[]): void;
    info(message: string, ...data: unknown[]): void;
    warn(message: string, ...data: unknown[]): void;
    error(message: string, ...data: unknown[]): void;
  };
}

export type CommandRunnerFactory = (input: CommandRunnerFactoryInput) => CommandRunner;

export interface CommandRateLimiter {
  checkLimit(): boolean;
}

interface CommandHandlerLogger {
  debug(message: string, ...data: unknown[]): void;
  info(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
}

export interface CommandHandlerOptions {
  roomConfig: CommandHandlerRoomConfig;
  history: ChatHistoryStore;
  classifyMode: (context: Array<{ role: string; content: string }>) => Promise<string>;
  runnerFactory?: CommandRunnerFactory;
  rateLimiter?: CommandRateLimiter;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  modelAdapter?: PiAiModelAdapter;
  refusalFallbackModel?: string;
  persistenceSummaryModel?: string;
  contextReducer?: ContextReducer;
  contextReducerConfig?: ContextReducerConfig;
  autoChronicler?: AutoChronicler;
  chronicleStore?: Pick<ChronicleStore, "getChapterContextMessages">;
  responseCleaner?: (text: string, nick: string) => string;
  helpToken?: string;
  flagTokens?: string[];
  onProgressReport?: (text: string) => void | Promise<void>;
  toolOptions?: Omit<BaselineToolOptions, "onProgressReport">;
  logger?: CommandHandlerLogger;
  agentLoop?: {
    maxIterations?: number;
    maxCompletionRetries?: number;
    emptyCompletionRetryPrompt?: string;
  };
}

export interface CommandExecutionResult {
  response: string | null;
  resolved: ResolvedCommand;
  model: string | null;
  usage: Usage | null;
  toolCallsCount: number;
}

export interface HandleIncomingMessageOptions {
  isDirect: boolean;
  sendResponse?: (text: string) => Promise<void>;
}

interface RunWithFallbackResult {
  agentResult: SingleTurnResult;
  modelSpec: string;
  fallbackModelSpec: string | null;
}

/**
 * Shared TS command execution path (without proactive handling).
 */
export class RoomCommandHandlerTs {
  readonly resolver: CommandResolver;
  private readonly commandConfig: CommandConfig;
  private readonly runnerFactory: CommandRunnerFactory;
  private readonly rateLimiter: CommandRateLimiter;
  private readonly steeringQueue: SteeringQueue;
  private readonly modelAdapter: PiAiModelAdapter;
  private readonly refusalFallbackModel: string | null;
  private readonly responseMaxBytes: number;
  private readonly shareArtifact: (content: string) => Promise<string>;
  private readonly contextReducer: ContextReducer;
  private readonly autoChronicler: AutoChronicler | null;
  private readonly chronicleStore: Pick<ChronicleStore, "getChapterContextMessages"> | null;
  private readonly logger: CommandHandlerLogger;

  constructor(private readonly options: CommandHandlerOptions) {
    this.commandConfig = options.roomConfig.command;

    this.resolver = new CommandResolver(
      this.commandConfig,
      options.classifyMode,
      options.helpToken ?? "!h",
      new Set(options.flagTokens ?? ["!c"]),
      modelStrCore,
    );

    this.modelAdapter = options.modelAdapter ?? new PiAiModelAdapter();
    this.logger = options.logger ?? createConsoleLogger("muaddib.rooms.command");

    this.runnerFactory =
      options.runnerFactory ??
      ((input) =>
        new MuaddibAgentRunner({
          model: input.model,
          systemPrompt: input.systemPrompt,
          tools: input.tools,
          modelAdapter: this.modelAdapter,
          getApiKey: options.getApiKey,
          maxIterations: options.agentLoop?.maxIterations,
          maxCompletionRetries: options.agentLoop?.maxCompletionRetries,
          emptyCompletionRetryPrompt: options.agentLoop?.emptyCompletionRetryPrompt,
          logger: input.logger,
        } as MuaddibAgentRunnerOptions));

    this.refusalFallbackModel = options.refusalFallbackModel
      ? normalizeModelSpec(options.refusalFallbackModel)
      : null;
    this.responseMaxBytes = parseResponseMaxBytes(this.commandConfig.response_max_bytes);
    const defaultExecutors = createDefaultToolExecutors(options.toolOptions ?? {});
    this.shareArtifact =
      options.toolOptions?.executors?.shareArtifact ?? defaultExecutors.shareArtifact;
    this.contextReducer =
      options.contextReducer ??
      new ContextReducerTs({
        config: options.contextReducerConfig,
        modelAdapter: this.modelAdapter,
        getApiKey: options.getApiKey,
      });
    this.autoChronicler = options.autoChronicler ?? null;
    this.chronicleStore = options.chronicleStore ?? null;

    this.rateLimiter =
      options.rateLimiter ??
      new RateLimiter(
        numberWithDefault(this.commandConfig.rate_limit, 30),
        numberWithDefault(this.commandConfig.rate_period, 900),
      );
    this.steeringQueue = new SteeringQueue();
  }

  shouldIgnoreUser(nick: string): boolean {
    const ignoreUsers = this.commandConfig.ignore_users ?? [];
    return ignoreUsers.some((ignored) => String(ignored).toLowerCase() === nick.toLowerCase());
  }

  async handleIncomingMessage(
    message: RoomMessage,
    options: HandleIncomingMessageOptions,
  ): Promise<CommandExecutionResult | null> {
    const triggerMessageId = await this.options.history.addMessage(message);

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
      return this.executeAndPersist(
        message,
        triggerMessageId,
        options.sendResponse,
        SteeringQueue.keyForMessage(message),
      );
    }

    return this.runOrQueueCommand(message, triggerMessageId, options.sendResponse);
  }

  async execute(message: RoomMessage): Promise<CommandExecutionResult> {
    return this.executeWithSteering(message, SteeringQueue.keyForMessage(message));
  }

  private async executeWithSteering(
    message: RoomMessage,
    steeringKey: SteeringKey,
  ): Promise<CommandExecutionResult> {
    const defaultSize = this.commandConfig.history_size;
    const maxSize = Math.max(
      defaultSize,
      ...Object.values(this.commandConfig.modes).map((mode) => Number(mode.history_size ?? 0)),
    );

    if (!this.rateLimiter.checkLimit()) {
      this.logger.warn("Rate limit triggered", `arc=${message.serverTag}#${message.channelName}`, `nick=${message.nick}`);
      return this.rateLimitedResult(message);
    }

    this.logger.info(
      "Received command",
      `arc=${message.serverTag}#${message.channelName}`,
      `nick=${message.nick}`,
      `content=${message.content}`,
    );

    const context = await this.options.history.getContextForMessage(message, maxSize);
    const followupMessages = await this.collectDebouncedFollowups(message, context);

    const resolved = await this.resolver.resolve({
      message,
      context,
      defaultSize,
    });

    const resolvedWithFollowups: ResolvedCommand = {
      ...resolved,
      queryText: mergeQueryText(resolved.queryText, followupMessages),
    };

    if (resolvedWithFollowups.error) {
      this.logger.warn(
        "Command parse error",
        `arc=${message.serverTag}#${message.channelName}`,
        `nick=${message.nick}`,
        `error=${resolvedWithFollowups.error}`,
        `content=${message.content}`,
      );
      return {
        response: `${message.nick}: ${resolvedWithFollowups.error}`,
        resolved: resolvedWithFollowups,
        model: null,
        usage: null,
        toolCallsCount: 0,
      };
    }

    if (resolvedWithFollowups.helpRequested) {
      this.logger.debug("Sending help message", `nick=${message.nick}`);
      return {
        response: this.resolver.buildHelpMessage(message.serverTag, message.channelName),
        resolved: resolvedWithFollowups,
        model: null,
        usage: null,
        toolCallsCount: 0,
      };
    }

    if (
      !resolvedWithFollowups.modeKey ||
      !resolvedWithFollowups.runtime ||
      !resolvedWithFollowups.selectedTrigger
    ) {
      return {
        response: `${message.nick}: Internal command resolution error.`,
        resolved: resolvedWithFollowups,
        model: null,
        usage: null,
        toolCallsCount: 0,
      };
    }

    const modeConfig = this.commandConfig.modes[resolvedWithFollowups.modeKey];
    const modelSpec =
      resolvedWithFollowups.modelOverride ??
      resolvedWithFollowups.runtime.model ??
      pickModeModel(modeConfig.model) ??
      null;

    if (!modelSpec) {
      return {
        response: `${message.nick}: No model configured for mode '${resolvedWithFollowups.modeKey}'.`,
        resolved: resolvedWithFollowups,
        model: null,
        usage: null,
        toolCallsCount: 0,
      };
    }

    if (resolvedWithFollowups.modelOverride) {
      this.logger.debug("Overriding model", `model=${resolvedWithFollowups.modelOverride}`);
    }

    if (resolvedWithFollowups.selectedAutomatically) {
      this.logger.debug(
        "Processing automatic mode request",
        `nick=${message.nick}`,
        `query=${resolvedWithFollowups.queryText}`,
      );
      if (resolvedWithFollowups.channelMode) {
        this.logger.debug(
          "Channel policy resolved",
          `policy=${resolvedWithFollowups.channelMode}`,
          `label=${resolvedWithFollowups.selectedLabel}`,
          `trigger=${resolvedWithFollowups.selectedTrigger}`,
        );
      }
    } else {
      this.logger.debug(
        "Processing explicit trigger",
        `trigger=${resolvedWithFollowups.selectedTrigger}`,
        `mode=${resolvedWithFollowups.modeKey}`,
        `nick=${message.nick}`,
        `query=${resolvedWithFollowups.queryText}`,
      );
    }

    this.logger.info(
      "Resolved direct command",
      `arc=${message.serverTag}#${message.channelName}`,
      `mode=${resolvedWithFollowups.modeKey}`,
      `trigger=${resolvedWithFollowups.selectedTrigger}`,
      `model=${modelSpec}`,
      `context_disabled=${resolvedWithFollowups.noContext}`,
    );

    const steeringMessages =
      resolvedWithFollowups.runtime.steering && !resolvedWithFollowups.noContext
        ? this.steeringQueue.drainSteeringContextMessages(steeringKey)
        : [];

    const systemPrompt = this.buildSystemPrompt(
      resolvedWithFollowups.modeKey,
      message.mynick,
      resolvedWithFollowups.modelOverride ?? undefined,
    );

    let prependedContext: Array<{ role: string; content: string }> = [];
    if (
      !resolvedWithFollowups.noContext &&
      resolvedWithFollowups.runtime.includeChapterSummary &&
      this.chronicleStore
    ) {
      prependedContext = await this.chronicleStore.getChapterContextMessages(
        `${message.serverTag}#${message.channelName}`,
      );
    }

    let selectedContext = (resolvedWithFollowups.noContext ? context.slice(-1) : context).slice(
      -resolvedWithFollowups.runtime.historySize,
    );

    if (
      !resolvedWithFollowups.noContext &&
      resolvedWithFollowups.runtime.autoReduceContext &&
      this.contextReducer.isConfigured &&
      selectedContext.length > 1
    ) {
      const fullContext = [...prependedContext, ...selectedContext];
      const reducedContext = await this.contextReducer.reduce(fullContext, systemPrompt);
      prependedContext = [];
      selectedContext = [
        ...reducedContext,
        selectedContext[selectedContext.length - 1],
      ];
    }

    // The trigger message will be sent as the new prompt for this turn.
    // Keep only prior context from history here to avoid sending the trigger twice.
    const runnerContext = [
      ...prependedContext,
      ...selectedContext.slice(0, -1),
      ...steeringMessages,
    ].map(toRunnerContextMessage);

    const tools = this.selectTools(message, resolvedWithFollowups.runtime.allowedTools);

    const persistenceSummaryCallback = this.options.persistenceSummaryModel
      ? async (text: string) => {
          await this.options.history.addMessage(
            {
              ...message,
              nick: message.mynick,
              content: text,
            },
            {
              contentTemplate: "[internal monologue] {message}",
            },
          );
        }
      : undefined;

    let runResult: RunWithFallbackResult;
    try {
      runResult = await this.runWithRefusalFallback(
        modelSpec,
        {
          prompt: resolvedWithFollowups.queryText,
          contextMessages: runnerContext,
          thinkingLevel: normalizeThinkingLevel(resolvedWithFollowups.runtime.reasoningEffort),
          persistenceSummaryModel: this.options.persistenceSummaryModel,
          onPersistenceSummary: persistenceSummaryCallback,
          visionFallbackModel: resolvedWithFollowups.runtime.visionModel ?? undefined,
        },
        {
          systemPrompt,
          tools,
        },
      );
    } catch (error) {
      this.logger.error("Error during agent execution", error);
      throw error;
    }

    let responseText = runResult.agentResult.text;
    if (runResult.fallbackModelSpec) {
      const fallbackSpec = parseModelSpec(runResult.fallbackModelSpec);
      responseText = `${responseText} [refusal fallback to ${fallbackSpec.modelId}]`.trim();
    }

    responseText = await this.applyResponseLengthPolicy(responseText);
    const cleaned = this.cleanResponseText(responseText, message.nick);

    if (!cleaned) {
      this.logger.info(
        "Agent chose not to answer",
        `arc=${message.serverTag}#${message.channelName}`,
        `mode=${resolvedWithFollowups.selectedLabel}`,
        `trigger=${resolvedWithFollowups.selectedTrigger}`,
      );
    }

    return {
      response: cleaned || null,
      resolved: resolvedWithFollowups,
      model: runResult.modelSpec,
      usage: runResult.agentResult.usage,
      toolCallsCount: runResult.agentResult.toolCallsCount ?? 0,
    };
  }

  private async runWithRefusalFallback(
    primaryModelSpec: string,
    runInput: {
      prompt: string;
      contextMessages: RunnerContextMessage[];
      thinkingLevel: ThinkingLevel;
      persistenceSummaryModel?: string;
      onPersistenceSummary?: (text: string) => void | Promise<void>;
      visionFallbackModel?: string;
    },
    runnerInput: {
      systemPrompt: string;
      tools: AgentTool<any>[];
    },
  ): Promise<RunWithFallbackResult> {
    const primaryRunner = this.runnerFactory({
      model: primaryModelSpec,
      systemPrompt: runnerInput.systemPrompt,
      tools: runnerInput.tools,
      logger: this.logger,
    });

    const primarySummaryBuffer: string[] = [];
    const onPrimaryPersistenceSummary = runInput.onPersistenceSummary
      ? async (text: string) => {
          const trimmed = text.trim();
          if (trimmed) {
            primarySummaryBuffer.push(trimmed);
          }
        }
      : undefined;

    let primaryResult: SingleTurnResult;

    try {
      primaryResult = await primaryRunner.runSingleTurn(runInput.prompt, {
        contextMessages: runInput.contextMessages,
        thinkingLevel: runInput.thinkingLevel,
        persistenceSummaryModel: runInput.persistenceSummaryModel,
        onPersistenceSummary: onPrimaryPersistenceSummary,
        visionFallbackModel: runInput.visionFallbackModel,
      });
    } catch (error) {
      const refusalSignal = detectRefusalFallbackSignal(stringifyError(error));
      if (!refusalSignal || !this.refusalFallbackModel) {
        await this.flushPersistenceSummaryBuffer(runInput.onPersistenceSummary, primarySummaryBuffer);
        throw error;
      }

      this.logger.info(
        "Primary model failed with refusal signal; retrying fallback model",
        `signal=${refusalSignal}`,
        `fallback_model=${this.refusalFallbackModel}`,
      );

      const fallbackResult = await this.runFallbackModelTurn(
        this.refusalFallbackModel,
        runInput,
        runnerInput,
      );
      return {
        ...fallbackResult,
        fallbackModelSpec: this.refusalFallbackModel,
      };
    }

    const refusalSignal = detectRefusalFallbackSignal(primaryResult.text);
    if (!refusalSignal || !this.refusalFallbackModel) {
      await this.flushPersistenceSummaryBuffer(runInput.onPersistenceSummary, primarySummaryBuffer);
      return {
        agentResult: primaryResult,
        modelSpec: primaryModelSpec,
        fallbackModelSpec: null,
      };
    }

    this.logger.info(
      "Primary model response matched refusal signal; retrying fallback model",
      `signal=${refusalSignal}`,
      `fallback_model=${this.refusalFallbackModel}`,
    );

    const fallbackResult = await this.runFallbackModelTurn(this.refusalFallbackModel, runInput, runnerInput);
    return {
      ...fallbackResult,
      fallbackModelSpec: this.refusalFallbackModel,
    };
  }

  private async runFallbackModelTurn(
    fallbackModelSpec: string,
    runInput: {
      prompt: string;
      contextMessages: RunnerContextMessage[];
      thinkingLevel: ThinkingLevel;
      persistenceSummaryModel?: string;
      onPersistenceSummary?: (text: string) => void | Promise<void>;
      visionFallbackModel?: string;
    },
    runnerInput: {
      systemPrompt: string;
      tools: AgentTool<any>[];
    },
  ): Promise<RunWithFallbackResult> {
    const fallbackRunner = this.runnerFactory({
      model: fallbackModelSpec,
      systemPrompt: runnerInput.systemPrompt,
      tools: runnerInput.tools,
      logger: this.logger,
    });

    const fallbackSummaryBuffer: string[] = [];
    const onFallbackPersistenceSummary = runInput.onPersistenceSummary
      ? async (text: string) => {
          const trimmed = text.trim();
          if (trimmed) {
            fallbackSummaryBuffer.push(trimmed);
          }
        }
      : undefined;

    try {
      const fallbackResult = await fallbackRunner.runSingleTurn(runInput.prompt, {
        contextMessages: runInput.contextMessages,
        thinkingLevel: runInput.thinkingLevel,
        persistenceSummaryModel: runInput.persistenceSummaryModel,
        onPersistenceSummary: onFallbackPersistenceSummary,
        visionFallbackModel: runInput.visionFallbackModel,
      });

      await this.flushPersistenceSummaryBuffer(runInput.onPersistenceSummary, fallbackSummaryBuffer);

      return {
        agentResult: fallbackResult,
        modelSpec: fallbackModelSpec,
        fallbackModelSpec: null,
      };
    } catch (error) {
      await this.flushPersistenceSummaryBuffer(runInput.onPersistenceSummary, fallbackSummaryBuffer);
      throw error;
    }
  }

  private async flushPersistenceSummaryBuffer(
    callback: ((text: string) => void | Promise<void>) | undefined,
    summaries: string[],
  ): Promise<void> {
    if (!callback || summaries.length === 0) {
      return;
    }

    for (const summary of summaries) {
      await callback(summary);
    }
  }

  private async executeAndPersist(
    message: RoomMessage,
    triggerMessageId: number,
    sendResponse: ((text: string) => Promise<void>) | undefined,
    steeringKey: SteeringKey,
  ): Promise<CommandExecutionResult> {
    const result = await this.executeWithSteering(message, steeringKey);
    await this.persistExecutionResult(message, triggerMessageId, result, sendResponse);

    if (!this.isRateLimitedResult(result)) {
      await this.triggerAutoChronicler(message, this.commandConfig.history_size);
    }

    return result;
  }

  private async persistExecutionResult(
    message: RoomMessage,
    triggerMessageId: number,
    result: CommandExecutionResult,
    sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<void> {
    if (!result.response) {
      return;
    }

    const arcName = `${message.serverTag}#${message.channelName}`;

    let llmCallId: number | null = null;
    if (result.model && result.usage) {
      try {
        const spec = parseModelSpec(result.model);
        llmCallId = await this.options.history.logLlmCall({
          provider: spec.provider,
          model: spec.modelId,
          inputTokens: result.usage.input,
          outputTokens: result.usage.output,
          cost: result.usage.cost.total,
          callType: "agent_run",
          arcName,
          triggerMessageId,
        });
      } catch {
        this.logger.warn("Could not parse model spec", `model=${result.model}`);
      }
    }

    this.logger.debug(
      "Persisting direct command response",
      `arc=${arcName}`,
      `model=${result.model ?? "n/a"}`,
      `tool_calls=${result.toolCallsCount}`,
      `llm_call_id=${llmCallId ?? "n/a"}`,
    );

    const costStr = result.usage ? `$${result.usage.cost.total.toFixed(4)}` : "?";
    this.logger.info(
      "Sending direct response",
      `mode=${result.resolved.selectedLabel ?? "n/a"}`,
      `trigger=${result.resolved.selectedTrigger ?? "n/a"}`,
      `cost=${costStr}`,
      `arc=${arcName}`,
      `response=${result.response}`,
    );

    if (sendResponse) {
      await sendResponse(result.response);
    }

    const responseMessageId = await this.options.history.addMessage(
      {
        ...message,
        nick: message.mynick,
        content: result.response,
      },
      {
        mode: result.resolved.selectedTrigger ?? undefined,
        llmCallId,
      },
    );

    if (llmCallId) {
      await this.options.history.updateLlmCallResponse(llmCallId, responseMessageId);
    }

    this.logger.info(
      "Direct command response stored",
      `arc=${arcName}`,
      `response_message_id=${responseMessageId}`,
    );

    await this.emitCostFollowups(message, result, arcName, sendResponse);
  }

  private async emitCostFollowups(
    message: RoomMessage,
    result: CommandExecutionResult,
    arcName: string,
    sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<void> {
    if (!sendResponse || !result.usage) {
      return;
    }

    const totalCost = result.usage.cost.total;
    if (!(totalCost > 0)) {
      return;
    }

    if (totalCost > 0.2) {
      const costMessage = `(${[
        `this message used ${result.toolCallsCount} tool calls`,
        `${result.usage.input} in / ${result.usage.output} out tokens`,
        `and cost $${totalCost.toFixed(4)}`,
      ].join(", ")})`;

      this.logger.info("Sending cost followup", `arc=${arcName}`, `cost=${totalCost.toFixed(4)}`);
      await sendResponse(costMessage);
      await this.options.history.addMessage({
        ...message,
        nick: message.mynick,
        content: costMessage,
      });
    }

    const totalToday = await this.options.history.getArcCostToday(arcName);
    const costBefore = totalToday - totalCost;
    const dollarsBefore = Math.trunc(costBefore);
    const dollarsAfter = Math.trunc(totalToday);
    if (dollarsAfter <= dollarsBefore) {
      return;
    }

    const milestoneMessage =
      `(fun fact: my messages in this channel have already cost $${totalToday.toFixed(4)} today)`;
    this.logger.info("Sending daily cost milestone", `arc=${arcName}`, `total_today=${totalToday.toFixed(4)}`);
    await sendResponse(milestoneMessage);
    await this.options.history.addMessage({
      ...message,
      nick: message.mynick,
      content: milestoneMessage,
    });
  }

  private async runOrQueueCommand(
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

    let activeItem: QueuedInboundMessage | null = runnerItem;

    try {
      while (activeItem) {
        if (activeItem.kind === "command") {
          if (activeItem.triggerMessageId === null) {
            throw new Error("Queued command item is missing trigger message id.");
          }

          activeItem.result = await this.executeAndPersist(
            activeItem.message,
            activeItem.triggerMessageId,
            activeItem.sendResponse,
            steeringKey,
          );
        } else {
          await this.handlePassiveMessageCore(activeItem.message, activeItem.sendResponse);
          activeItem.result = null;
        }

        this.steeringQueue.finishItem(activeItem);

        const { dropped, nextItem } = this.steeringQueue.takeNextWorkCompacted(steeringKey);
        for (const droppedItem of dropped) {
          droppedItem.result = null;
          this.steeringQueue.finishItem(droppedItem);
        }

        activeItem = nextItem;
      }
    } catch (error) {
      this.steeringQueue.abortSession(steeringKey, error);
      if (activeItem) {
        this.steeringQueue.failItem(activeItem, error);
      }
      throw error;
    }

    return (runnerItem.result as CommandExecutionResult | null) ?? null;
  }

  private async handlePassiveMessage(
    message: RoomMessage,
    sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<void> {
    const queuedItem = this.steeringQueue.enqueuePassiveIfSessionExists(message, sendResponse);
    if (!queuedItem) {
      await this.handlePassiveMessageCore(message, sendResponse);
      return;
    }

    await queuedItem.completion;
  }

  private async handlePassiveMessageCore(
    message: RoomMessage,
    _sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<void> {
    await this.triggerAutoChronicler(message, this.commandConfig.history_size);
  }

  private async triggerAutoChronicler(message: RoomMessage, maxSize: number): Promise<void> {
    if (!this.autoChronicler) {
      return;
    }

    await this.autoChronicler.checkAndChronicle(
      message.mynick,
      message.serverTag,
      message.channelName,
      maxSize,
    );
  }

  buildSystemPrompt(mode: string, mynick: string, modelOverride?: string): string {
    const modeConfig = this.commandConfig.modes[mode];
    if (!modeConfig) {
      throw new Error(`Command mode '${mode}' not found in config`);
    }

    let promptTemplate = modeConfig.prompt ?? "You are {mynick}. Current time: {current_time}.";

    const triggerModelVars: Record<string, string> = {};
    for (const [trigger, modeKey] of Object.entries(this.resolver.triggerToMode)) {
      const triggerOverrideModel = this.resolver.triggerOverrides[trigger]?.model as string | undefined;
      const effectiveModel =
        triggerOverrideModel ??
        (modeKey === mode && modelOverride ? modelOverride : pickModeModel(this.commandConfig.modes[modeKey].model));
      triggerModelVars[`${trigger}_model`] = modelStrCore(effectiveModel ?? "");
    }

    promptTemplate = promptTemplate.replace(
      /\{(![A-Za-z][\w-]*_model)\}/g,
      (_full, key: string) => triggerModelVars[key] ?? _full,
    );

    const promptVars = this.options.roomConfig.prompt_vars ?? {};
    const vars: Record<string, string> = {
      ...promptVars,
      mynick,
      current_time: formatCurrentTime(),
    };

    return promptTemplate.replace(/\{([A-Za-z0-9_]+)\}/g, (full, key: string) => vars[key] ?? full);
  }

  private async collectDebouncedFollowups(
    message: RoomMessage,
    context: Array<{ role: string; content: string }>,
  ): Promise<string[]> {
    const debounceSeconds = numberWithDefault(this.commandConfig.debounce, 0);
    if (debounceSeconds <= 0) {
      return [];
    }

    const originalTimestamp = Date.now() / 1000;
    await sleep(debounceSeconds * 1000);

    const followups = await this.options.history.getRecentMessagesSince(
      message.serverTag,
      message.channelName,
      message.nick,
      originalTimestamp,
      message.threadId,
    );

    const followupMessages = followups.map((entry) => entry.message).filter((entry) => entry.length > 0);
    if (followupMessages.length > 0) {
      this.logger.debug("Debounced followup messages", `count=${followupMessages.length}`, `nick=${message.nick}`);
    }

    if (followupMessages.length > 0 && context.length > 0) {
      const lastIndex = context.length - 1;
      context[lastIndex] = {
        ...context[lastIndex],
        content: `${context[lastIndex].content}\n${followupMessages.join("\n")}`,
      };
    }

    return followupMessages;
  }

  private rateLimitedResult(message: RoomMessage): CommandExecutionResult {
    return {
      response: `${message.nick}: Slow down a little, will you? (rate limiting)`,
      resolved: {
        noContext: false,
        queryText: message.content,
        modelOverride: null,
        selectedLabel: null,
        selectedTrigger: null,
        modeKey: null,
        runtime: null,
        helpRequested: false,
        selectedAutomatically: false,
      },
      model: null,
      usage: null,
      toolCallsCount: 0,
    };
  }

  private isRateLimitedResult(result: CommandExecutionResult): boolean {
    return Boolean(result.response?.includes("(rate limiting)")) && !result.model;
  }

  private cleanResponseText(text: string, nick: string): string {
    const cleaned = stripLeadingIrcContextEchoPrefixes(text.trim());
    if (!this.options.responseCleaner) {
      return cleaned;
    }
    return this.options.responseCleaner(cleaned, nick).trim();
  }

  private async applyResponseLengthPolicy(responseText: string): Promise<string> {
    if (!responseText) {
      return responseText;
    }

    const responseBytes = byteLengthUtf8(responseText);
    if (responseBytes <= this.responseMaxBytes) {
      return responseText;
    }

    this.logger.info(
      "Response too long, creating artifact",
      `bytes=${responseBytes}`,
      `max_bytes=${this.responseMaxBytes}`,
    );

    return await this.longResponseToArtifact(responseText);
  }

  private async longResponseToArtifact(fullResponse: string): Promise<string> {
    const artifactResult = await this.shareArtifact(fullResponse);
    const artifactUrl = extractSharedArtifactUrl(artifactResult);

    let trimmed = trimToMaxBytes(fullResponse, this.responseMaxBytes);

    const minLength = Math.max(0, trimmed.length - 100);
    const lastSentence = trimmed.lastIndexOf(".");
    const lastWord = trimmed.lastIndexOf(" ");
    if (lastSentence > minLength) {
      trimmed = trimmed.slice(0, lastSentence + 1);
    } else if (lastWord > minLength) {
      trimmed = trimmed.slice(0, lastWord);
    }

    return `${trimmed}... full response: ${artifactUrl}`;
  }

  private selectTools(message: RoomMessage, allowedTools: string[] | null): AgentTool<any>[] {
    const baseline = createBaselineAgentTools({
      ...this.options.toolOptions,
      chronicleArc: `${message.serverTag}#${message.channelName}`,
      secrets: message.secrets,
      onProgressReport: this.options.onProgressReport,
    });

    if (!allowedTools) {
      return baseline;
    }

    const allowed = new Set(allowedTools);
    return baseline.filter((tool) => allowed.has(tool.name));
  }
}

const REFUSAL_FALLBACK_SIGNAL_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
}> = [
  {
    label: "structured_refusal",
    pattern: /["']is_refusal["']\s*:\s*true/iu,
  },
  {
    label: "python_refusal_message",
    pattern: /the ai refused to respond to this request/iu,
  },
  {
    label: "openai_invalid_prompt_safety",
    pattern: /invalid_prompt[\s\S]{0,160}safety reasons/iu,
  },
  {
    label: "content_safety_refusal",
    pattern: /content safety refusal/iu,
  },
];

function detectRefusalFallbackSignal(text: string): string | null {
  const candidate = text.trim();
  if (!candidate) {
    return null;
  }

  for (const signal of REFUSAL_FALLBACK_SIGNAL_PATTERNS) {
    if (signal.pattern.test(candidate)) {
      return signal.label;
    }
  }

  return null;
}

const LEADING_IRC_CONTEXT_ECHO_PREFIX_RE = /^(?:\s*(?:\[[^\]]+\]\s*)?(?:![A-Za-z][\w-]*\s+)?(?:\[?\d{1,2}:\d{2}\]?\s*)?(?:<(?!\/?quest(?:_finished)?\b)[^>]+>))*\s*/iu;

function stripLeadingIrcContextEchoPrefixes(text: string): string {
  return text.replace(LEADING_IRC_CONTEXT_ECHO_PREFIX_RE, "");
}

function normalizeModelSpec(model: string): string {
  const spec = parseModelSpec(model);
  return `${spec.provider}:${spec.modelId}`;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function numberWithDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function mergeQueryText(queryText: string, followupMessages: string[]): string {
  if (followupMessages.length === 0) {
    return queryText;
  }
  if (!queryText.trim()) {
    return followupMessages.join("\n");
  }
  return `${queryText}\n${followupMessages.join("\n")}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function modelStrCore(model: unknown): string {
  return String(model).replace(/(?:[-\w]*:)?(?:[-\w]*\/)?([-\w]+)(?:#[-\w,]*)?/, "$1");
}

function pickModeModel(model: string | string[] | undefined): string | null {
  if (!model) {
    return null;
  }
  if (Array.isArray(model)) {
    return model[0] ?? null;
  }
  return model;
}

function toRunnerContextMessage(message: { role: string; content: string }): RunnerContextMessage {
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
  };
}

function normalizeThinkingLevel(reasoningEffort: string): ThinkingLevel {
  switch (reasoningEffort) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return reasoningEffort;
    default:
      return "minimal";
  }
}

function formatCurrentTime(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function parseResponseMaxBytes(value: unknown): number {
  if (value === undefined || value === null) {
    return 600;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("command.response_max_bytes must be a positive integer.");
  }

  return parsed;
}

function byteLengthUtf8(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function trimToMaxBytes(text: string, maxBytes: number): string {
  let trimmed = text;
  while (trimmed.length > 0 && byteLengthUtf8(trimmed) > maxBytes) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function extractSharedArtifactUrl(result: string): string {
  const prefix = "Artifact shared: ";
  if (!result.startsWith(prefix)) {
    throw new Error(
      `response_max_bytes artifact fallback expected 'Artifact shared: <url>' but got: ${result}`,
    );
  }

  return result.slice(prefix.length).trim();
}
