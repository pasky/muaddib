/**
 * Command execution engine.
 *
 * Responsible for: context building, mode resolution, tool selection,
 * agent invocation, result processing, persistence, and response delivery.
 *
 * Stateless with respect to steering sessions — takes a message, runs it,
 * returns a result. All queue/session lifecycle stays in message-handler.
 */

import type { AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { type Usage } from "@mariozechner/pi-ai";

import {
  SessionRunner,
  type PromptOptions,
  type PromptResult,
} from "../../agent/session-runner.js";
import type { SessionFactoryContextMessage } from "../../agent/session-factory.js";
import {
  createBaselineAgentTools,
  createDefaultToolExecutors,
  type BaselineToolOptions,
  type MuaddibTool,
} from "../../agent/tools/baseline-tools.js";
import type { ChatHistoryStore, ChatRole } from "../../history/chat-history-store.js";
import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import { parseModelSpec } from "../../models/model-spec.js";
import { ContextReducerTs, type ContextReducer } from "./context-reducer.js";
import type { RoomMessage } from "../message.js";
import type { MuaddibRuntime } from "../../runtime.js";
import { createModeClassifier } from "./classifier.js";
import { RateLimiter } from "./rate-limiter.js";
import {
  CommandResolver,
  type CommandConfig,
  type ResolvedCommand,
} from "./resolver.js";
import type { ProactiveConfig } from "./proactive.js";
import { generateToolSummaryFromSession } from "./tool-summary.js";

// ── Public types ──

export interface CommandExecutionResult {
  response: string | null;
  resolved: ResolvedCommand;
  model: string | null;
  usage: Usage | null;
  toolCallsCount: number;
}

export interface CommandRunnerFactoryInput {
  model: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  steeringMessageProvider?: () => SessionFactoryContextMessage[];
  logger?: CommandExecutorLogger;
}

export type CommandRunnerFactory = (input: CommandRunnerFactoryInput) => {
  prompt(prompt: string, options?: PromptOptions): Promise<PromptResult>;
};

export interface CommandRateLimiter {
  checkLimit(): boolean;
}

export interface CommandExecutorLogger {
  debug(message: string, ...data: unknown[]): void;
  info(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
}

/** Callback to drain steering context messages during agent execution. */
export type SteeringContextDrainer = () => Array<{ role: ChatRole; content: string }>;

export interface CommandExecutorOverrides {
  responseCleaner?: (text: string, nick: string) => string;
  runnerFactory?: CommandRunnerFactory;
  rateLimiter?: CommandRateLimiter;
  contextReducer?: ContextReducer;
  onProgressReport?: (text: string) => void | Promise<void>;
}

// ── Executor ──

export class CommandExecutor {
  readonly resolver: CommandResolver;
  readonly classifyMode: (context: Array<{ role: string; content: string }>) => Promise<string>;
  private readonly commandConfig: CommandConfig;
  private readonly history: ChatHistoryStore;
  private readonly modelAdapter: PiAiModelAdapter;
  private readonly logger: CommandExecutorLogger;
  private readonly getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

  private readonly runtime: MuaddibRuntime;
  private readonly roomName: string;
  private readonly overrides?: CommandExecutorOverrides;
  private readonly runnerFactory: CommandRunnerFactory;
  private readonly rateLimiter: CommandRateLimiter;
  private readonly contextReducer: ContextReducer;
  private readonly refusalFallbackModel: string | null;
  private readonly persistenceSummaryModel: string | null;
  private readonly responseMaxBytes: number;
  private readonly shareArtifact: (content: string) => Promise<string>;

  constructor(runtime: MuaddibRuntime, roomName: string, overrides?: CommandExecutorOverrides) {
    this.runtime = runtime;
    this.roomName = roomName;
    this.overrides = overrides;

    const roomConfig = runtime.config.getRoomConfig(roomName);
    if (!roomConfig.command) {
      throw new Error(`rooms.${roomName}.command is missing.`);
    }

    const actorConfig = runtime.config.getActorConfig();

    this.commandConfig = roomConfig.command;
    this.history = runtime.history;
    this.getApiKey = runtime.getApiKey;
    this.logger = runtime.logger.getLogger(`muaddib.rooms.command.${roomName}`);
    this.modelAdapter = runtime.modelAdapter ?? new PiAiModelAdapter();

    this.classifyMode = createModeClassifier(this.commandConfig, {
      getApiKey: runtime.getApiKey,
      modelAdapter: runtime.modelAdapter,
      logger: this.logger,
    });

    this.resolver = new CommandResolver(
      this.commandConfig,
      this.classifyMode,
      "!h",
      new Set(["!c"]),
      modelStrCore,
    );

    this.runnerFactory =
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

    this.rateLimiter =
      overrides?.rateLimiter ??
      new RateLimiter(
        numberWithDefault(this.commandConfig.rate_limit, 30),
        numberWithDefault(this.commandConfig.rate_period, 900),
      );

    this.refusalFallbackModel = resolveConfigModelSpec(
      runtime.config.getRouterConfig().refusalFallbackModel,
      "router.refusal_fallback_model",
    ) ?? null;

    this.persistenceSummaryModel = resolveConfigModelSpec(
      runtime.config.getToolsConfig().summary?.model,
      "tools.summary.model",
    ) ?? null;

    this.responseMaxBytes = parseResponseMaxBytes(this.commandConfig.response_max_bytes);

    this.contextReducer =
      overrides?.contextReducer ??
      new ContextReducerTs({
        config: runtime.config.getContextReducerConfig(),
        modelAdapter: this.modelAdapter,
        getApiKey: runtime.getApiKey,
        logger: this.logger,
      });

    const defaultExecutors = createDefaultToolExecutors(this.buildToolOptions());
    this.shareArtifact = defaultExecutors.shareArtifact;
  }

  private buildToolOptions(): Omit<BaselineToolOptions, "onProgressReport"> {
    return {
      toolsConfig: this.runtime.config.getToolsConfig(),
      providersConfig: this.runtime.config.getProvidersConfig(),
      getApiKey: this.runtime.getApiKey,
      logger: this.logger,
      chronicleStore: this.runtime.chronicleStore,
      chronicleLifecycle: this.runtime.chronicleLifecycle,
    };
  }

  /**
   * Execute a command: resolve mode, build context, run agent, process result,
   * persist, and deliver response.
   */
  async execute(
    message: RoomMessage,
    triggerMessageId: number,
    sendResponse: ((text: string) => Promise<void>) | undefined,
    steeringContextDrainer?: SteeringContextDrainer,
  ): Promise<CommandExecutionResult> {
    const result = await this.executeCore(message, steeringContextDrainer);
    await this.persistExecutionResult(message, triggerMessageId, result, sendResponse);

    if (!this.isRateLimitedResult(result)) {
      await this.triggerAutoChronicler(message, this.commandConfig.history_size);
    }

    return result;
  }

  /**
   * Execute a proactive interjection in serious mode with extra prompt.
   * Returns true if a response was actually sent.
   */
  async executeProactive(
    message: RoomMessage,
    sendResponse: ((text: string) => Promise<void>) | undefined,
    proactiveConfig: ProactiveConfig,
    classifiedTrigger: string,
    classifiedRuntime: { steering?: boolean; reasoningEffort: string; allowedTools: string[] | null },
    steeringContextDrainer?: SteeringContextDrainer,
  ): Promise<boolean> {
    const { logger } = this;
    const modelSpec = proactiveConfig.models.serious;
    const systemPrompt =
      this.buildSystemPrompt("serious", message.mynick) +
      " " + proactiveConfig.prompts.serious_extra;

    const context = await this.history.getContextForMessage(
      message,
      proactiveConfig.history_size,
    );

    const steeringEnabled = Boolean(classifiedRuntime.steering);
    const initialSteeringMessages = steeringEnabled && steeringContextDrainer
      ? steeringContextDrainer()
      : [];

    const runnerContext: SessionFactoryContextMessage[] = [
      ...context.slice(0, -1),
      ...initialSteeringMessages,
    ];

    const tools = this.selectTools(message, classifiedRuntime.allowedTools, runnerContext);

    const steeringMessageProvider = steeringEnabled && steeringContextDrainer
      ? () => steeringContextDrainer().map((msg) => ({
          role: "user" as const,
          content: msg.content,
        }))
      : undefined;

    const runner = this.runnerFactory({
      model: modelSpec,
      systemPrompt,
      tools,
      steeringMessageProvider,
      logger,
    });

    const lastMessage = context[context.length - 1];
    const queryText = lastMessage?.content ?? "";

    let agentResult: PromptResult;
    try {
      agentResult = await runner.prompt(queryText, {
        contextMessages: runnerContext,
        thinkingLevel: normalizeThinkingLevel(classifiedRuntime.reasoningEffort),
        refusalFallbackModel: this.refusalFallbackModel ?? undefined,
      });

      await this.persistGeneratedToolSummary(message, agentResult, tools as MuaddibTool[]);
      agentResult.session?.dispose();
    } catch (error) {
      logger.error("Error during proactive agent execution", error);
      return false;
    }

    let responseText = agentResult.text;
    if (!responseText || responseText.startsWith("Error: ")) {
      logger.info(
        "Agent decided not to interject proactively",
        `arc=${message.serverTag}#${message.channelName}`,
      );
      return false;
    }

    responseText = await this.applyResponseLengthPolicy(responseText);
    responseText = this.cleanResponseText(responseText, message.nick);

    if (!responseText) {
      return false;
    }

    responseText = `[${modelStrCore(modelSpec)}] ${responseText}`;

    logger.info(
      "Sending proactive response",
      `arc=${message.serverTag}#${message.channelName}`,
      `label=${classifiedTrigger}`,
      `trigger=${classifiedTrigger}`,
      `response=${responseText}`,
    );

    if (sendResponse) {
      await sendResponse(responseText);
    }

    await this.history.addMessage(
      {
        ...message,
        nick: message.mynick,
        content: responseText,
      },
      {
        mode: classifiedTrigger,
      },
    );

    await this.triggerAutoChronicler(message, this.commandConfig.history_size);
    return true;
  }

  // ── Core execution (no persistence/delivery) ──

  private async executeCore(
    message: RoomMessage,
    steeringContextDrainer?: SteeringContextDrainer,
  ): Promise<CommandExecutionResult> {
    const { commandConfig, logger } = this;
    const defaultSize = commandConfig.history_size;
    const maxSize = Math.max(
      defaultSize,
      ...Object.values(commandConfig.modes).map((mode) => Number(mode.history_size ?? 0)),
    );

    if (!this.rateLimiter.checkLimit()) {
      logger.warn("Rate limit triggered", `arc=${message.serverTag}#${message.channelName}`, `nick=${message.nick}`);
      return this.rateLimitedResult(message);
    }

    logger.info(
      "Received command",
      `arc=${message.serverTag}#${message.channelName}`,
      `nick=${message.nick}`,
      `content=${message.content}`,
    );

    const context = await this.history.getContextForMessage(message, maxSize);

    const resolved = await this.resolver.resolve({
      message,
      context,
      defaultSize,
    });

    if (resolved.error) {
      logger.warn(
        "Command parse error",
        `arc=${message.serverTag}#${message.channelName}`,
        `nick=${message.nick}`,
        `error=${resolved.error}`,
        `content=${message.content}`,
      );
      return {
        response: `${message.nick}: ${resolved.error}`,
        resolved: resolved,
        model: null,
        usage: null,
        toolCallsCount: 0,
      };
    }

    if (resolved.helpRequested) {
      logger.debug("Sending help message", `nick=${message.nick}`);
      return {
        response: this.resolver.buildHelpMessage(message.serverTag, message.channelName),
        resolved: resolved,
        model: null,
        usage: null,
        toolCallsCount: 0,
      };
    }

    if (
      !resolved.modeKey ||
      !resolved.runtime ||
      !resolved.selectedTrigger
    ) {
      return {
        response: `${message.nick}: Internal command resolution error.`,
        resolved: resolved,
        model: null,
        usage: null,
        toolCallsCount: 0,
      };
    }

    const modeConfig = commandConfig.modes[resolved.modeKey];
    const modelSpec =
      resolved.modelOverride ??
      resolved.runtime.model ??
      pickModeModel(modeConfig.model) ??
      null;

    if (!modelSpec) {
      return {
        response: `${message.nick}: No model configured for mode '${resolved.modeKey}'.`,
        resolved: resolved,
        model: null,
        usage: null,
        toolCallsCount: 0,
      };
    }

    if (resolved.modelOverride) {
      logger.debug("Overriding model", `model=${resolved.modelOverride}`);
    }

    if (resolved.selectedAutomatically) {
      logger.debug(
        "Processing automatic mode request",
        `nick=${message.nick}`,
        `query=${resolved.queryText}`,
      );
      if (resolved.channelMode) {
        logger.debug(
          "Channel policy resolved",
          `policy=${resolved.channelMode}`,
          `label=${resolved.selectedLabel}`,
          `trigger=${resolved.selectedTrigger}`,
        );
      }
    } else {
      logger.debug(
        "Processing explicit trigger",
        `trigger=${resolved.selectedTrigger}`,
        `mode=${resolved.modeKey}`,
        `nick=${message.nick}`,
        `query=${resolved.queryText}`,
      );
    }

    logger.debug(
      "Resolved direct command",
      `arc=${message.serverTag}#${message.channelName}`,
      `mode=${resolved.modeKey}`,
      `trigger=${resolved.selectedTrigger}`,
      `model=${modelSpec}`,
      `context_disabled=${resolved.noContext}`,
    );

    const steeringEnabled =
      Boolean(resolved.runtime.steering) && !resolved.noContext;

    // Wait the debounce period so that rapid follow-up messages land in
    // the steering queue before the first LLM invocation.
    const debounceSeconds = numberWithDefault(this.commandConfig.debounce, 0);
    if (debounceSeconds > 0) {
      await sleep(debounceSeconds * 1000);
    }

    // Drain any messages that arrived during the debounce window.
    const initialSteeringMessages = steeringEnabled && steeringContextDrainer
      ? steeringContextDrainer()
      : [];

    const systemPrompt = this.buildSystemPrompt(
      resolved.modeKey,
      message.mynick,
      resolved.modelOverride ?? undefined,
    );

    let prependedContext: Array<{ role: ChatRole; content: string }> = [];
    if (
      !resolved.noContext &&
      resolved.runtime.includeChapterSummary &&
      this.runtime.chronicleStore
    ) {
      prependedContext = await this.runtime.chronicleStore.getChapterContextMessages(
        `${message.serverTag}#${message.channelName}`,
      );
    }

    let selectedContext = (resolved.noContext ? context.slice(-1) : context).slice(
      -resolved.runtime.historySize,
    );

    if (
      !resolved.noContext &&
      resolved.runtime.autoReduceContext &&
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

    const runnerContext: SessionFactoryContextMessage[] = [
      ...prependedContext,
      ...selectedContext.slice(0, -1),
      ...initialSteeringMessages,
    ];

    const tools = this.selectTools(message, resolved.runtime.allowedTools, runnerContext);

    const steeringMessageProvider = steeringEnabled && steeringContextDrainer
      ? () => steeringContextDrainer().map((msg) => ({
          role: "user" as const,
          content: msg.content,
        }))
      : undefined;

    const runner = this.runnerFactory({
      model: modelSpec,
      systemPrompt,
      tools,
      steeringMessageProvider,
      logger,
    });

    let agentResult: PromptResult;
    try {
      agentResult = await runner.prompt(resolved.queryText, {
        contextMessages: runnerContext,
        thinkingLevel: normalizeThinkingLevel(resolved.runtime.reasoningEffort),
        visionFallbackModel: resolved.runtime.visionModel ?? undefined,
        refusalFallbackModel: this.refusalFallbackModel ?? undefined,
      });

      await this.persistGeneratedToolSummary(message, agentResult, tools as MuaddibTool[]);
      agentResult.session?.dispose();
    } catch (error) {
      logger.error("Error during agent execution", error);
      throw error;
    }

    let responseText = agentResult.text;
    if (agentResult.refusalFallbackActivated && agentResult.refusalFallbackModel) {
      const fallbackSpec = parseModelSpec(agentResult.refusalFallbackModel);
      responseText = `${responseText} [refusal fallback to ${fallbackSpec.modelId}]`.trim();
    }

    responseText = await this.applyResponseLengthPolicy(responseText);
    const cleaned = this.cleanResponseText(responseText, message.nick);

    if (!cleaned) {
      logger.info(
        "Agent chose not to answer",
        `arc=${message.serverTag}#${message.channelName}`,
        `mode=${resolved.selectedLabel}`,
        `trigger=${resolved.selectedTrigger}`,
      );
    }

    return {
      response: cleaned || null,
      resolved: resolved,
      model: modelSpec,
      usage: agentResult.usage,
      toolCallsCount: agentResult.toolCallsCount ?? 0,
    };
  }

  // ── Persistence & response delivery ──

  private async persistExecutionResult(
    message: RoomMessage,
    triggerMessageId: number,
    result: CommandExecutionResult,
    sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<void> {
    if (!result.response) {
      return;
    }

    const { history, logger } = this;
    const arcName = `${message.serverTag}#${message.channelName}`;

    let llmCallId: number | null = null;
    if (result.model && result.usage) {
      try {
        const spec = parseModelSpec(result.model);
        llmCallId = await history.logLlmCall({
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
        logger.warn("Could not parse model spec", `model=${result.model}`);
      }
    }

    logger.debug(
      "Persisting direct command response",
      `arc=${arcName}`,
      `model=${result.model ?? "n/a"}`,
      `tool_calls=${result.toolCallsCount}`,
      `llm_call_id=${llmCallId ?? "n/a"}`,
    );

    const costStr = result.usage ? `$${result.usage.cost.total.toFixed(4)}` : "?";
    logger.info(
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

    const responseMessageId = await history.addMessage(
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
      await history.updateLlmCallResponse(llmCallId, responseMessageId);
    }

    logger.debug(
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

    const { history, logger } = this;
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

      logger.info("Sending cost followup", `arc=${arcName}`, `cost=${totalCost.toFixed(4)}`);
      await sendResponse(costMessage);
      await history.addMessage({
        ...message,
        nick: message.mynick,
        content: costMessage,
      });
    }

    const totalToday = await history.getArcCostToday(arcName);
    const costBefore = totalToday - totalCost;
    const dollarsBefore = Math.trunc(costBefore);
    const dollarsAfter = Math.trunc(totalToday);
    if (dollarsAfter <= dollarsBefore) {
      return;
    }

    const milestoneMessage =
      `(fun fact: my messages in this channel have already cost $${totalToday.toFixed(4)} today)`;
    logger.info("Sending daily cost milestone", `arc=${arcName}`, `total_today=${totalToday.toFixed(4)}`);
    await sendResponse(milestoneMessage);
    await history.addMessage({
      ...message,
      nick: message.mynick,
      content: milestoneMessage,
    });
  }

  // ── Helpers ──

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

    const promptVars = this.runtime.config.getRoomConfig(this.roomName).prompt_vars ?? {};
    const vars: Record<string, string> = {
      ...promptVars,
      mynick,
      current_time: formatCurrentTime(),
    };

    return promptTemplate.replace(/\{([A-Za-z0-9_]+)\}/g, (full, key: string) => vars[key] ?? full);
  }

  async triggerAutoChronicler(message: RoomMessage, maxSize?: number): Promise<void> {
    maxSize ??= this.commandConfig.history_size;
    if (!this.runtime.autoChronicler) {
      return;
    }

    await this.runtime.autoChronicler.checkAndChronicle(
      message.mynick,
      message.serverTag,
      message.channelName,
      maxSize,
    );
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
    if (!this.overrides?.responseCleaner) {
      return cleaned;
    }
    return this.overrides?.responseCleaner(cleaned, nick).trim();
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

  private async persistGeneratedToolSummary(
    message: RoomMessage,
    result: PromptResult,
    tools: MuaddibTool[],
  ): Promise<void> {
    const summaryText = await generateToolSummaryFromSession({
      result,
      tools,
      persistenceSummaryModel: this.persistenceSummaryModel,
      modelAdapter: this.modelAdapter,
      logger: this.logger,
      arc: `${message.serverTag}#${message.channelName}`,
      getApiKey: this.getApiKey,
    });

    if (!summaryText) {
      return;
    }

    await this.history.addMessage(
      {
        ...message,
        nick: message.mynick,
        content: summaryText,
      },
      {
        contentTemplate: "[internal monologue] {message}",
      },
    );
  }

  selectTools(
    message: RoomMessage,
    allowedTools: string[] | null,
    conversationContext?: SessionFactoryContextMessage[],
  ): MuaddibTool[] {
    const invocationToolOptions: BaselineToolOptions = {
      ...this.buildToolOptions(),
      arc: `${message.serverTag}#${message.channelName}`,
      secrets: message.secrets,
    };

    const baseline = createBaselineAgentTools({
      ...invocationToolOptions,
      onProgressReport: this.overrides?.onProgressReport,
      oracleInvocation: {
        conversationContext: conversationContext ?? [],
        toolOptions: invocationToolOptions,
        buildTools: createBaselineAgentTools,
      },
    });

    if (!allowedTools) {
      return baseline;
    }

    const allowed = new Set(allowedTools);
    return baseline.filter((tool) => allowed.has(tool.name));
  }
}

// ── Module-level helpers ──

// ── Shared utility functions (exported for message-handler) ──

export function modelStrCore(model: unknown): string {
  return String(model).replace(/(?:[-\w]*:)?(?:[-\w]*\/)?([-\w]+)(?:#[-\w,]*)?/, "$1");
}

export function pickModeModel(model: string | string[] | undefined): string | null {
  if (!model) {
    return null;
  }
  if (Array.isArray(model)) {
    return model[0] ?? null;
  }
  return model;
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

function numberWithDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
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

function resolveConfigModelSpec(
  raw: unknown,
  configKey: string,
): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${configKey} must be a non-empty string fully qualified as provider:model.`);
  }

  const trimmed = raw.trim();
  const spec = parseModelSpec(trimmed);
  return `${spec.provider}:${spec.modelId}`;
}

const LEADING_IRC_CONTEXT_ECHO_PREFIX_RE = /^(?:\s*(?:\[[^\]]+\]\s*)?(?:![A-Za-z][\w-]*\s+)?(?:\[?\d{1,2}:\d{2}\]?\s*)?(?:<(?!\/?quest(?:_finished)?\b)[^>]+>))*\s*/iu;

function stripLeadingIrcContextEchoPrefixes(text: string): string {
  return text.replace(LEADING_IRC_CONTEXT_ECHO_PREFIX_RE, "");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatCurrentTime(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
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
