/**
 * Command execution engine.
 *
 * Responsible for: context building, mode resolution, tool selection,
 * agent invocation, result processing, persistence, and response delivery.
 *
 * Stateless with respect to steering sessions — takes a message, runs it,
 * returns a result. All queue/session lifecycle stays in message-handler.
 */

import type { Agent, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { type Usage } from "@mariozechner/pi-ai";

import { formatUtcTime, messageText } from "../../utils/index.js";
import {
  SessionRunner,
  type PromptOptions,
  type PromptResult,
} from "../../agent/session-runner.js";

import {
  createBaselineAgentTools,
  type BaselineToolOptions,
  type MuaddibTool,
  type ToolSet,
} from "../../agent/tools/baseline-tools.js";
import { writeArtifactText } from "../../agent/tools/artifact-storage.js";
import type { Message } from "@mariozechner/pi-ai";
import type { ChatHistoryStore } from "../../history/chat-history-store.js";
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
import type { Logger } from "../../app/logging.js";
import type { AgentConfig, MemoryConfig, SkillsConfig } from "../../config/muaddib-config.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getArcWorkspacePath } from "../../agent/tools/gondolin-tools.js";
import { loadWorkspaceSkills } from "../../agent/skills/load-skills.js";

// ── Public types ──

export type CommandExecutorLogger = Logger;

export interface SendResult {
  platformId?: string;
  /** When true, the message was coalesced into an existing platform message via edit. */
  isEdit?: boolean;
  /** The full coalesced content after edit (set when isEdit is true). */
  combinedContent?: string;
}

/** Callback for sending a message to the room. May return the outbound platform ID. */
export type SendResponse = (text: string) => Promise<SendResult | void>;

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
  toolSet: ToolSet;
  metaReminder?: string;
  progressThresholdSeconds?: number;
  progressMinIntervalSeconds?: number;
  onStatusMessage?: (text: string) => void | Promise<void>;
  logger?: Logger;
  onAgentCreated?: (agent: Agent) => void;
}

export type CommandRunnerFactory = (input: CommandRunnerFactoryInput) => {
  prompt(prompt: string, options?: PromptOptions): Promise<PromptResult>;
};

export interface CommandRateLimiter {
  checkLimit(): boolean;
}

/** Result from invokeAndPostProcess — the shared agent invocation tail. */
interface PromptRunResult {
  responseText: string;
  usage: Usage | null;
  toolCallsCount: number;
  /** Deferred work (tool summary, memory update, session dispose) that callers await after sending the response. */
  backgroundWork?: Promise<void>;
}

export interface CommandExecutorOverrides {
  responseCleaner?: (text: string, nick: string) => string;
  runnerFactory?: CommandRunnerFactory;
  rateLimiter?: CommandRateLimiter;
  contextReducer?: ContextReducer;
}

// ── Executor ──

export class CommandExecutor {
  readonly resolver: CommandResolver;
  readonly classifyMode: (context: Message[]) => Promise<string>;
  private readonly commandConfig: CommandConfig;
  private readonly history: ChatHistoryStore;
  private readonly modelAdapter: PiAiModelAdapter;
  private readonly logger: Logger;

  private readonly runtime: MuaddibRuntime;
  private readonly roomName: string;
  private readonly overrides?: CommandExecutorOverrides;
  private readonly runnerFactory: CommandRunnerFactory;
  private readonly rateLimiter: CommandRateLimiter;
  private readonly contextReducer: ContextReducer;
  private readonly refusalFallbackModel: string | null;
  private readonly persistenceSummaryModel: string | null;
  private readonly responseMaxBytes: number;

  private readonly agentConfig: AgentConfig;

  constructor(runtime: MuaddibRuntime, roomName: string, overrides?: CommandExecutorOverrides) {
    this.runtime = runtime;
    this.roomName = roomName;
    this.overrides = overrides;

    const roomConfig = runtime.config.getRoomConfig(roomName);
    if (!roomConfig.command) {
      throw new Error(`rooms.${roomName}.command is missing.`);
    }

    const agentConfig = runtime.config.getAgentConfig();
    this.agentConfig = agentConfig;

    this.commandConfig = roomConfig.command;
    this.history = runtime.history;
    this.logger = runtime.logger.getLogger(`muaddib.rooms.command.${roomName}`);
    this.modelAdapter = runtime.modelAdapter;

    this.classifyMode = createModeClassifier(this.commandConfig, {
      modelAdapter: this.modelAdapter,
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
          toolSet: input.toolSet,
          modelAdapter: this.modelAdapter,
          authStorage: runtime.authStorage,
          maxIterations: agentConfig.maxIterations,
          llmDebugMaxChars: agentConfig.llmDebugMaxChars,
          metaReminder: input.metaReminder,
          progressThresholdSeconds: input.progressThresholdSeconds,
          progressMinIntervalSeconds: input.progressMinIntervalSeconds,
          onStatusMessage: input.onStatusMessage,
          logger: input.logger,
          onAgentCreated: input.onAgentCreated,
        }));

    this.rateLimiter =
      overrides?.rateLimiter ??
      new RateLimiter(
        numberWithDefault(this.commandConfig.rateLimit, 30),
        numberWithDefault(this.commandConfig.ratePeriod, 900),
      );

    this.refusalFallbackModel = resolveConfigModelSpec(
      agentConfig.refusalFallbackModel,
      "agent.refusalFallbackModel",
    ) ?? null;

    this.persistenceSummaryModel = resolveConfigModelSpec(
      this.commandConfig.toolSummary?.model,
      "command.toolSummary.model",
    ) ?? null;

    this.responseMaxBytes = parseResponseMaxBytes(this.commandConfig.responseMaxBytes);

    this.contextReducer =
      overrides?.contextReducer ??
      new ContextReducerTs({
        config: this.commandConfig.contextReducer,
        modelAdapter: this.modelAdapter,
        logger: this.logger,
      });


  }

  private buildToolOptions(): Omit<BaselineToolOptions, "arc" | "onProgressReport"> {
    return {
      toolsConfig: this.agentConfig.tools,
      authStorage: this.runtime.authStorage,
      modelAdapter: this.modelAdapter,
      logger: this.logger,
    };
  }

  /**
   * Execute a command: resolve mode, build context, run agent, process result,
   * persist, and deliver response.
   */
  async execute(
    message: RoomMessage,
    triggerTs: string,
    sendResponse: SendResponse | undefined,
    onAgentCreated?: (agent: Agent) => void,
  ): Promise<CommandExecutionResult> {
    const { commandConfig, logger } = this;
    const defaultSize = commandConfig.historySize;
    const maxSize = Math.max(
      defaultSize,
      ...Object.values(commandConfig.modes).map((mode) => Number(mode.historySize ?? 0)),
    );

    // ── Rate limit ──

    if (!this.rateLimiter.checkLimit()) {
      logger.warn("Rate limit triggered", `arc=${message.arc}`, `nick=${message.nick}`);
      return await this.deliverResult(message, triggerTs, sendResponse, {
        response: `${message.nick}: Slow down a little, will you? (rate limiting)`,
        resolved: EMPTY_RESOLVED,
      });
    }

    logger.info(
      "Received command",
      `arc=${message.arc}`,
      `nick=${message.nick}`,
      `content=${message.content}`,
    );

    // ── Resolve command ──

    const context = await this.history.getContextForMessage(message, maxSize);

    const resolved = await this.resolver.resolve({
      message,
      context,
      defaultSize,
    });

    if (resolved.error) {
      logger.warn(
        "Command parse error",
        `arc=${message.arc}`,
        `nick=${message.nick}`,
        `error=${resolved.error}`,
        `content=${message.content}`,
      );
      return await this.deliverResult(message, triggerTs, sendResponse, {
        response: `${message.nick}: ${resolved.error}`, resolved,
      });
    }

    if (resolved.helpRequested) {
      logger.debug("Sending help message", `nick=${message.nick}`);
      return await this.deliverResult(message, triggerTs, sendResponse, {
        response: this.resolver.buildHelpMessage(message.serverTag, message.channelName), resolved,
      });
    }

    if (!resolved.modeKey || !resolved.runtime || !resolved.selectedTrigger) {
      return await this.deliverResult(message, triggerTs, sendResponse, {
        response: `${message.nick}: Internal command resolution error.`, resolved,
      });
    }

    const modeConfig = commandConfig.modes[resolved.modeKey];
    const modelSpec =
      resolved.modelOverride ??
      resolved.runtime.model ??
      pickModeModel(modeConfig.model) ??
      null;

    if (!modelSpec) {
      return await this.deliverResult(message, triggerTs, sendResponse, {
        response: `${message.nick}: No model configured for mode '${resolved.modeKey}'.`, resolved,
      });
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
      `arc=${message.arc}`,
      `mode=${resolved.modeKey}`,
      `trigger=${resolved.selectedTrigger}`,
      `model=${modelSpec}`,
      `context_disabled=${resolved.noContext}`,
    );

    // ── Build context & invoke agent ──

    const systemPrompt = this.buildSystemPrompt(
      resolved.modeKey,
      message.mynick,
      resolved.modelOverride ?? undefined,
      resolved.selectedTrigger ?? undefined,
    );

    let prependedContext: Message[] = [];
    if (
      !resolved.noContext &&
      resolved.runtime.includeChapterSummary &&
      this.runtime.chronicle?.chronicleStore
    ) {
      prependedContext = await this.runtime.chronicle.chronicleStore.getChapterContextMessages(
        message.arc,
      );
    }

    let selectedContext: Message[] = (resolved.noContext ? context.slice(-1) : context).slice(
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

    const runnerContext: Message[] = [
      ...prependedContext,
      ...selectedContext.slice(0, -1),
    ];

    const toolSet = this.selectTools(message, resolved.runtime.allowedTools, runnerContext, sendResponse, triggerTs);

    const progressConfig = this.agentConfig.progress;
    const runner = this.runnerFactory({
      model: modelSpec,
      systemPrompt,
      toolSet,
      metaReminder: modeConfig.promptReminder,
      progressThresholdSeconds: progressConfig?.thresholdSeconds,
      progressMinIntervalSeconds: progressConfig?.minIntervalSeconds,
      onStatusMessage: sendResponse ? (text: string) => { sendResponse(text); } : undefined,
      logger,
      onAgentCreated,
    });

    const queryTimestamp = formatUtcTime().slice(-5); // HH:MM in UTC, matching history format
    const queryContent = message.originalContent ?? resolved.queryText;
    const { responseText, usage, toolCallsCount, backgroundWork } = await this.invokeAndPostProcess(
      runner, message, `[${queryTimestamp}] <${message.nick}> ${queryContent}`, runnerContext, toolSet.tools, {
        reasoningEffort: resolved.runtime.reasoningEffort,
        visionModel: resolved.runtime.visionModel ?? undefined,
        memoryUpdate: resolved.runtime.memoryUpdate,
      }, triggerTs,
    );

    if (!responseText) {
      logger.info(
        "Agent chose not to answer",
        `arc=${message.arc}`,
        `mode=${resolved.selectedLabel}`,
        `trigger=${resolved.selectedTrigger}`,
      );
    }

    // ── Deliver & persist ──

    const result = await this.deliverResult(message, triggerTs, sendResponse, {
      response: responseText || null, resolved, model: modelSpec, usage, toolCallsCount,
    });

    // Tool summary, memory update, and session dispose run after the response is sent.
    await backgroundWork;
    await this.triggerAutoChronicler(message, this.commandConfig.historySize);

    return result;
  }

  /**
   * Execute a proactive interjection in serious mode with extra prompt.
   * Returns true if a response was actually sent.
   */
  async executeProactive(
    message: RoomMessage,
    sendResponse: SendResponse | undefined,
    proactiveConfig: ProactiveConfig,
    classifiedTrigger: string,
    classifiedRuntime: { reasoningEffort: string; allowedTools: string[] | null },
    onAgentCreated?: (agent: Agent) => void,
  ): Promise<boolean> {
    const { logger } = this;
    const modelSpec = proactiveConfig.models.serious;
    const systemPrompt =
      this.buildSystemPrompt("serious", message.mynick) +
      " " + proactiveConfig.prompts.seriousExtra;

    const context = await this.history.getContextForMessage(
      message,
      proactiveConfig.historySize,
    );

    const runnerContext: Message[] = [
      ...context.slice(0, -1),
    ];

    const toolSet = this.selectTools(message, classifiedRuntime.allowedTools, runnerContext, sendResponse);

    const proactiveProgressConfig = this.agentConfig.progress;
    const runner = this.runnerFactory({
      model: modelSpec,
      systemPrompt,
      toolSet,
      metaReminder: this.commandConfig.modes.serious?.promptReminder,
      progressThresholdSeconds: proactiveProgressConfig?.thresholdSeconds,
      progressMinIntervalSeconds: proactiveProgressConfig?.minIntervalSeconds,
      onStatusMessage: sendResponse ? (text: string) => { sendResponse(text); } : undefined,
      logger,
      onAgentCreated,
    });

    const lastMessage = context[context.length - 1];
    const queryText = lastMessage ? messageText(lastMessage) : "";

    let result: PromptRunResult;
    try {
      result = await this.invokeAndPostProcess(runner, message, queryText, runnerContext, toolSet.tools, {
        reasoningEffort: classifiedRuntime.reasoningEffort,
      });
    } catch (error) {
      logger.error("Error during proactive agent execution", error);
      return false;
    }

    const proactiveText = result.responseText.trim();
    if (!proactiveText || proactiveText.startsWith("Error: ") || isNullSentinel(proactiveText)) {
      logger.info(
        "Agent decided not to interject proactively",
        `arc=${message.arc}`,
      );
      await result.backgroundWork;
      return false;
    }

    const responseText = `[${modelStrCore(modelSpec)}] ${proactiveText}`;

    logger.info(
      "Sending proactive response",
      `arc=${message.arc}`,
      `label=${classifiedTrigger}`,
      `trigger=${classifiedTrigger}`,
      `response=${responseText}`,
    );

    let proactiveSendResult: SendResult | undefined;
    if (sendResponse) {
      const sr = await sendResponse(responseText);
      if (sr) proactiveSendResult = sr;
    }

    await this.persistBotResponse(message.arc, message, responseText, proactiveSendResult, {
      mode: classifiedTrigger,
    });

    await result.backgroundWork;
    await this.triggerAutoChronicler(message, this.commandConfig.historySize);
    return true;
  }

  // ── Shared: prompt invocation + post-processing ──

  /**
   * Invoke the agent runner, persist tool summaries, dispose session,
   * and post-process the response (refusal annotation, length policy, cleaning).
   */
  private async invokeAndPostProcess(
    runner: { prompt(prompt: string, options?: PromptOptions): Promise<PromptResult> },
    message: RoomMessage,
    queryText: string,
    contextMessages: Message[],
    tools: MuaddibTool[],
    opts: { reasoningEffort: string; visionModel?: string; memoryUpdate?: boolean },
    triggerTs?: string,
  ): Promise<PromptRunResult> {
    const agentResult = await runner.prompt(queryText, {
      contextMessages,
      thinkingLevel: normalizeThinkingLevel(opts.reasoningEffort),
      visionFallbackModel: opts.visionModel,
      refusalFallbackModel: this.refusalFallbackModel ?? undefined,
    });

    // Extract and post-process response text immediately — don't block on
    // tool summary / memory update which are independent of the response.
    let responseText = agentResult.text;
    if (agentResult.refusalFallbackActivated && agentResult.refusalFallbackModel) {
      const fallbackSpec = parseModelSpec(agentResult.refusalFallbackModel);
      responseText = `${responseText} [refusal fallback to ${fallbackSpec.modelId}]`.trim();
    }
    if (agentResult.visionFallbackActivated && agentResult.visionFallbackModel) {
      const fallbackSpec = parseModelSpec(agentResult.visionFallbackModel);
      responseText = `${responseText} [vision fallback to ${fallbackSpec.modelId}]`.trim();
    }

    responseText = await this.applyResponseLengthPolicy(responseText, message.arc);
    responseText = this.cleanResponseText(responseText, message.nick);

    // Deferred: tool summary persistence, memory update, session dispose.
    // Callers await this *after* sending the response so the user isn't blocked.
    const backgroundWork = (async () => {
      await this.persistGeneratedToolSummary(message, agentResult, tools, triggerTs);

      if (opts.memoryUpdate !== false && agentResult.session) {
        try {
          agentResult.bumpMaxIterations?.(5);
          const memoryPrompt = buildMemoryUpdatePrompt(message.arc, this.agentConfig.tools?.memory, {
            toolCallsCount: agentResult.toolCallsCount ?? 0,
            skillsConfig: this.agentConfig.tools?.skills,
          });
          await agentResult.session.prompt(memoryPrompt);
        } catch (err) {
          this.logger.warn("Memory update failed", String(err));
        }
      }

      agentResult.session?.dispose();
    })();

    return {
      responseText,
      usage: agentResult.usage,
      toolCallsCount: agentResult.toolCallsCount ?? 0,
      backgroundWork,
    };
  }

  // ── Response delivery & persistence ──

  /**
   * Deliver a command execution result: log LLM call, send response,
   * persist bot message, and emit cost followups.
   */
  private async deliverResult(
    message: RoomMessage,
    triggerTs: string,
    sendResponse: SendResponse | undefined,
    partial: {
      response: string | null;
      resolved: ResolvedCommand;
      model?: string | null;
      usage?: Usage | null;
      toolCallsCount?: number;
    },
  ): Promise<CommandExecutionResult> {
    const result: CommandExecutionResult = {
      model: null,
      usage: null,
      toolCallsCount: 0,
      ...partial,
    };

    if (!result.response) {
      return result;
    }

    const { logger } = this;
    const arcName = message.arc;

    logger.debug(
      "Persisting direct command response",
      `arc=${arcName}`,
      `model=${result.model ?? "n/a"}`,
      `tool_calls=${result.toolCallsCount}`,
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

    let sendResult: SendResult | undefined;
    if (sendResponse) {
      const sr = await sendResponse(result.response);
      if (sr) sendResult = sr;
    }

    await this.persistBotResponse(arcName, message, result.response, sendResult, {
      mode: result.resolved.selectedTrigger ?? undefined,
      run: triggerTs || undefined,
      call: result.model ? "agent_run" : undefined,
      model: result.model ?? undefined,
      inTok: result.usage?.input,
      outTok: result.usage?.output,
      cost: result.usage?.cost.total,
    });

    logger.debug(
      "Direct command response stored",
      `arc=${arcName}`,
    );

    await this.emitCostFollowups(message, result, arcName, sendResponse, triggerTs);

    return result;
  }

  private async emitCostFollowups(
    message: RoomMessage,
    result: CommandExecutionResult,
    arcName: string,
    sendResponse: SendResponse | undefined,
    triggerTs?: string,
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
      const costSendResult = await sendResponse(costMessage);
      const costSR = costSendResult ? costSendResult : undefined;
      await this.persistBotResponse(arcName, message, costMessage, costSR, { run: triggerTs });
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
    const milestoneSendResult = await sendResponse(milestoneMessage);
    const milestoneSR = milestoneSendResult ? milestoneSendResult : undefined;
    await this.persistBotResponse(arcName, message, milestoneMessage, milestoneSR, { run: triggerTs });
  }

  // ── Bot message persistence ──

  /**
   * Persist a bot response to history, handling edit-coalesce vs new-message branching.
   * Constructs the bot RoomMessage explicitly — only the fields that belong on a bot message
   * are carried from the triggering user message (no `originalContent`, `secrets`, etc.).
   */
  private async persistBotResponse(
    arcName: string,
    message: RoomMessage,
    content: string,
    sendResult: SendResult | undefined,
    options?: {
      mode?: string;
      run?: string;
      call?: string;
      model?: string;
      inTok?: number;
      outTok?: number;
      cost?: number;
      contentTemplate?: string;
    },
  ): Promise<void> {
    if (sendResult?.isEdit && sendResult.platformId && sendResult.combinedContent) {
      await this.history.appendEdit(
        arcName,
        sendResult.platformId,
        sendResult.combinedContent,
        message.mynick,
        "assistant",
      );
    } else {
      const botMessage: RoomMessage = {
        serverTag: message.serverTag,
        channelName: message.channelName,
        arc: message.arc,
        nick: message.mynick,
        mynick: message.mynick,
        content,
        platformId: sendResult?.platformId,
        threadId: message.threadId,
        responseThreadId: message.responseThreadId,
      };
      await this.history.addMessage(botMessage, options);
    }
  }

  // ── Helpers ──

  buildSystemPrompt(mode: string, mynick: string, modelOverride?: string, selectedTrigger?: string): string {
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

    const promptVars = this.runtime.config.getRoomConfig(this.roomName).promptVars ?? {};
    const vars: Record<string, string> = {
      ...promptVars,
      mynick,
      current_time: formatUtcTime(),
      ...(selectedTrigger ? { current_trigger: selectedTrigger } : {}),
      ...(selectedTrigger && triggerModelVars[`${selectedTrigger}_model`]
        ? { current_model: triggerModelVars[`${selectedTrigger}_model`] }
        : {}),
    };

    return promptTemplate.replace(/\{([A-Za-z0-9_]+)\}/g, (full, key: string) => vars[key] ?? full);
  }

  async triggerAutoChronicler(message: RoomMessage, maxSize?: number): Promise<void> {
    maxSize ??= this.commandConfig.historySize;
    if (!this.runtime.chronicle?.autoChronicler) {
      return;
    }

    await this.runtime.chronicle.autoChronicler.checkAndChronicle(
      message.mynick,
      message.serverTag,
      message.channelName,
      maxSize,
    );
  }

  private cleanResponseText(text: string, nick: string): string {
    const cleaned = stripLeadingIrcContextEchoPrefixes(text.trim());
    if (!this.overrides?.responseCleaner) {
      return cleaned;
    }
    return this.overrides?.responseCleaner(cleaned, nick).trim();
  }

  private async applyResponseLengthPolicy(responseText: string, _arc: string): Promise<string> {
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
    const { toolsConfig, logger } = this.buildToolOptions();
    const artifactUrl = await writeArtifactText({ toolsConfig, logger }, fullResponse, ".txt");

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
    triggerTs?: string,
  ): Promise<void> {
    const summaryText = await generateToolSummaryFromSession({
      result,
      tools,
      persistenceSummaryModel: this.persistenceSummaryModel,
      modelAdapter: this.modelAdapter,
      logger: this.logger,
      arc: message.arc,
    });

    if (!summaryText) {
      return;
    }

    await this.persistBotResponse(message.arc, message, summaryText, undefined, {
      contentTemplate: "[internal monologue] {message}",
      run: triggerTs,
    });
  }

  selectTools(
    message: RoomMessage,
    allowedTools: string[] | null,
    conversationContext?: Message[],
    sendResponse?: SendResponse,
    triggerTs?: string,
  ): ToolSet {
    const invocationToolOptions: BaselineToolOptions = {
      ...this.buildToolOptions(),
      arc: message.arc,
      secrets: message.secrets,
    };

    // Build per-invocation progress callback: send to room + persist in history.
    const onProgressReport: ((text: string) => void | Promise<void>) | undefined =
      sendResponse
        ? async (text: string) => {
            const sr = await sendResponse(text);
            const sendResult = sr ? sr : undefined;
            await this.persistBotResponse(message.arc, message, text, sendResult, {
              run: triggerTs,
            });
          }
        : undefined;

    const toolSet = createBaselineAgentTools({
      ...invocationToolOptions,
      onProgressReport,
      oracleInvocation: {
        conversationContext: conversationContext ?? [],
        toolOptions: invocationToolOptions,
        buildTools: createBaselineAgentTools,
      },
    });

    if (!allowedTools) {
      return toolSet;
    }

    const allowed = new Set(allowedTools);
    return { tools: toolSet.tools.filter((tool) => allowed.has(tool.name)), dispose: toolSet.dispose, systemPromptSuffix: toolSet.systemPromptSuffix };
  }
}

const EMPTY_RESOLVED: ResolvedCommand = Object.freeze({
  noContext: false,
  queryText: "",
  modelOverride: null,
  selectedLabel: null,
  selectedTrigger: null,
  modeKey: null,
  runtime: null,
  helpRequested: false,
  selectedAutomatically: false,
});

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

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function normalizeThinkingLevel(reasoningEffort: string): ThinkingLevel {
  if (VALID_THINKING_LEVELS.has(reasoningEffort as ThinkingLevel)) {
    return reasoningEffort as ThinkingLevel;
  }
  throw new Error(
    `Invalid reasoningEffort '${reasoningEffort}'. Valid values: ${[...VALID_THINKING_LEVELS].join(", ")}`,
  );
}

function numberWithDefault(value: unknown, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a number but got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseResponseMaxBytes(value: unknown): number {
  if (value === undefined || value === null) {
    return 600;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("command.responseMaxBytes must be a positive integer.");
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

/**
 * Matches leading IRC-style context echo prefixes that LLMs sometimes parrot back.
 * These are sequences of timestamp / mode-trigger / nick patterns, e.g.:
 *   "[12:34] <SomeUser>"
 *   "[claude-sonnet-4] !s <SomeUser>"
 *   "[15:00] <Bot> !q <User>"
 */
const LEADING_IRC_CONTEXT_ECHO_PREFIX_RE = /^(?:\s*(?:\[[^\]]+\]\s*)?(?:![A-Za-z][\w-]*\s+)?(?:\[?\d{1,2}:\d{2}\]?\s*)?(?:<[^>]+>))*\s*/iu;

/**
 * Matches a bare command-dispatch prefix the LLM may echo without IRC angle brackets,
 * e.g. "!d caster:" or "!d caster,".  The nick part is required so we don't strip
 * a legitimate "!something" at the start of a real response.
 */
const BARE_COMMAND_PREFIX_RE = /^![A-Za-z]\s+\S+[,:]\s*/u;

/** Strip leading IRC context echo prefixes that LLMs sometimes parrot from conversation history. */
function stripLeadingIrcContextEchoPrefixes(text: string): string {
  return text.replace(LEADING_IRC_CONTEXT_ECHO_PREFIX_RE, "").replace(BARE_COMMAND_PREFIX_RE, "");
}

function isNullSentinel(text: string): boolean {
  const trimmed = text.trim();
  const unquoted = trimmed.replace(/^["'`]|["'`]$/g, "").trim();
  return /^null$/iu.test(unquoted);
}



function byteLengthUtf8(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
const DEFAULT_SKILL_CREATION_THRESHOLD = 4;

export interface PostSessionOptions {
  toolCallsCount?: number;
  skillsConfig?: SkillsConfig;
}

export function buildMemoryUpdatePrompt(arc: string, memoryConfig?: MemoryConfig, options?: PostSessionOptions): string {
  const charLimit = memoryConfig?.charLimit ?? DEFAULT_MEMORY_CHAR_LIMIT;
  const workspacePath = getArcWorkspacePath(arc);
  const memoryPath = join(workspacePath, "MEMORY.md");

  let content = "";
  if (existsSync(memoryPath)) {
    try {
      content = readFileSync(memoryPath, "utf8");
    } catch {
      // Best-effort read
    }
  }

  const chars = content.length;
  const capacityWarning = chars >= charLimit * 0.8
    ? " - you must consolidate existing entries if you add something"
    : "";

  const displayContent = content.trim() || "(empty - not yet created)";

  let prompt = `<meta>Session complete. Here is your current /workspace/MEMORY.md (${chars}/${charLimit} chars${capacityWarning}):\n---\n${displayContent}\n---\nIf you learned something worth persisting for the long term (beyond the continuously moving chronicle: user preferences, big lessons, key decisions), update /workspace/MEMORY.md using the edit or write tool. Keep entries concise. If nothing worth saving, do nothing.`;

  // Skill creation section - appended when session was complex enough
  const toolCallsCount = options?.toolCallsCount ?? 0;
  const threshold = options?.skillsConfig?.creationThreshold ?? DEFAULT_SKILL_CREATION_THRESHOLD;

  if (toolCallsCount >= threshold) {
    const existingSkills = loadWorkspaceSkills(workspacePath);
    const skillsList = existingSkills.length > 0
      ? existingSkills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
      : "(none)";

    prompt += `\n\nSkill creation: this session used ${toolCallsCount} tool calls. Consider saving a reusable skill at /workspace/skills/<name>/SKILL.md if:\n- The procedure was complex and hard to discover (required trial & error or user correction)\n- You recognize a pattern you've solved before or will likely need again\nExisting workspace skills:\n${skillsList}\nSee the manage-skills skill for format. If nothing worth capturing, do nothing.`;
  }

  prompt += "</meta>";
  return prompt;
}

function trimToMaxBytes(text: string, maxBytes: number): string {
  if (byteLengthUtf8(text) <= maxBytes) {
    return text;
  }
  // Slice the buffer and decode; the decoder drops any incomplete trailing character.
  return new TextDecoder("utf-8", { fatal: false }).decode(
    Buffer.from(text, "utf-8").subarray(0, maxBytes),
  ).replace(/\uFFFD$/, "");
}
