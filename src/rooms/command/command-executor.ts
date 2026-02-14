/**
 * Command execution engine.
 *
 * Responsible for: context building, mode resolution, tool selection,
 * agent invocation, result processing, persistence, and response delivery.
 *
 * Stateless with respect to steering sessions — takes a message, runs it,
 * returns a result.  All queue/session lifecycle stays in command-handler.
 */

import type { AgentMessage, AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { type Usage } from "@mariozechner/pi-ai";

import type {
  PromptOptions,
  PromptResult,
} from "../../agent/session-runner.js";
import type { SessionFactoryContextMessage } from "../../agent/session-factory.js";
import type { ChronicleStore } from "../../chronicle/chronicle-store.js";
import {
  createBaselineAgentTools,
  type BaselineToolOptions,
  type MuaddibTool,
  type ToolPersistType,
} from "../../agent/tools/baseline-tools.js";
import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import { parseModelSpec } from "../../models/model-spec.js";
import type { AutoChronicler } from "../autochronicler.js";
import type { ContextReducer } from "./context-reducer.js";
import type { RoomMessage } from "../message.js";
import {
  CommandResolver,
  type CommandConfig,
  type ResolvedCommand,
} from "./resolver.js";
import type { ProactiveConfig } from "./proactive.js";

// ── Public types ──

export interface CommandExecutionResult {
  response: string | null;
  resolved: ResolvedCommand;
  model: string | null;
  usage: Usage | null;
  toolCallsCount: number;
}

export interface CommandRunner {
  prompt(prompt: string, options?: PromptOptions): Promise<PromptResult>;
}

export interface CommandRunnerFactoryInput {
  model: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  steeringMessageProvider?: () => SessionFactoryContextMessage[];
  logger?: CommandExecutorLogger;
}

export type CommandRunnerFactory = (input: CommandRunnerFactoryInput) => CommandRunner;

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
export type SteeringContextDrainer = () => Array<{ role: string; content: string }>;

export interface CommandExecutorDeps {
  commandConfig: CommandConfig;
  promptVars?: Record<string, string>;
  history: ChatHistoryStore;
  resolver: CommandResolver;
  runnerFactory: CommandRunnerFactory;
  rateLimiter: CommandRateLimiter;
  modelAdapter: PiAiModelAdapter;
  contextReducer: ContextReducer;
  autoChronicler: AutoChronicler | null;
  chronicleStore: Pick<ChronicleStore, "getChapterContextMessages"> | null;
  logger: CommandExecutorLogger;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  refusalFallbackModel: string | null;
  persistenceSummaryModel: string | null;
  responseMaxBytes: number;
  shareArtifact: (content: string) => Promise<string>;
  responseCleaner?: (text: string, nick: string) => string;
  onProgressReport?: (text: string) => void | Promise<void>;
  toolOptions?: Omit<BaselineToolOptions, "onProgressReport">;
}

// ── Executor ──

export class CommandExecutor {
  private readonly deps: CommandExecutorDeps;

  constructor(deps: CommandExecutorDeps) {
    this.deps = deps;
  }

  /** Convenience accessors used by command-handler for dispatch decisions. */
  get resolver(): CommandResolver {
    return this.deps.resolver;
  }

  get commandConfig(): CommandConfig {
    return this.deps.commandConfig;
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
      await this.triggerAutoChronicler(message, this.deps.commandConfig.history_size);
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
    const { logger } = this.deps;
    const modelSpec = proactiveConfig.models.serious;
    const systemPrompt =
      this.buildSystemPrompt("serious", message.mynick) +
      " " + proactiveConfig.prompts.serious_extra;

    const context = await this.deps.history.getContextForMessage(
      message,
      proactiveConfig.history_size,
    );

    const steeringEnabled = Boolean(classifiedRuntime.steering);
    const initialSteeringMessages = steeringEnabled && steeringContextDrainer
      ? steeringContextDrainer()
      : [];

    const runnerContext = [
      ...context.slice(0, -1),
      ...initialSteeringMessages,
    ].map(toRunnerContextMessage);

    const tools = this.selectTools(message, classifiedRuntime.allowedTools, runnerContext);

    const steeringMessageProvider = steeringEnabled && steeringContextDrainer
      ? () => steeringContextDrainer().map((msg) => ({
          role: "user" as const,
          content: msg.content,
        }))
      : undefined;

    const runner = this.deps.runnerFactory({
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
        refusalFallbackModel: this.deps.refusalFallbackModel ?? undefined,
      });

      await this.persistToolSummaryFromSession(message, agentResult, tools as MuaddibTool[]);
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

    await this.deps.history.addMessage(
      {
        ...message,
        nick: message.mynick,
        content: responseText,
      },
      {
        mode: classifiedTrigger,
      },
    );

    await this.triggerAutoChronicler(message, this.deps.commandConfig.history_size);
    return true;
  }

  // ── Core execution (no persistence/delivery) ──

  private async executeCore(
    message: RoomMessage,
    steeringContextDrainer?: SteeringContextDrainer,
  ): Promise<CommandExecutionResult> {
    const { commandConfig, logger } = this.deps;
    const defaultSize = commandConfig.history_size;
    const maxSize = Math.max(
      defaultSize,
      ...Object.values(commandConfig.modes).map((mode) => Number(mode.history_size ?? 0)),
    );

    if (!this.deps.rateLimiter.checkLimit()) {
      logger.warn("Rate limit triggered", `arc=${message.serverTag}#${message.channelName}`, `nick=${message.nick}`);
      return this.rateLimitedResult(message);
    }

    logger.info(
      "Received command",
      `arc=${message.serverTag}#${message.channelName}`,
      `nick=${message.nick}`,
      `content=${message.content}`,
    );

    const context = await this.deps.history.getContextForMessage(message, maxSize);
    const followupMessages = await this.collectDebouncedFollowups(message, context);

    const resolved = await this.deps.resolver.resolve({
      message,
      context,
      defaultSize,
    });

    const resolvedWithFollowups: ResolvedCommand = {
      ...resolved,
      queryText: mergeQueryText(resolved.queryText, followupMessages),
    };

    if (resolvedWithFollowups.error) {
      logger.warn(
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
      logger.debug("Sending help message", `nick=${message.nick}`);
      return {
        response: this.deps.resolver.buildHelpMessage(message.serverTag, message.channelName),
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

    const modeConfig = commandConfig.modes[resolvedWithFollowups.modeKey];
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
      logger.debug("Overriding model", `model=${resolvedWithFollowups.modelOverride}`);
    }

    if (resolvedWithFollowups.selectedAutomatically) {
      logger.debug(
        "Processing automatic mode request",
        `nick=${message.nick}`,
        `query=${resolvedWithFollowups.queryText}`,
      );
      if (resolvedWithFollowups.channelMode) {
        logger.debug(
          "Channel policy resolved",
          `policy=${resolvedWithFollowups.channelMode}`,
          `label=${resolvedWithFollowups.selectedLabel}`,
          `trigger=${resolvedWithFollowups.selectedTrigger}`,
        );
      }
    } else {
      logger.debug(
        "Processing explicit trigger",
        `trigger=${resolvedWithFollowups.selectedTrigger}`,
        `mode=${resolvedWithFollowups.modeKey}`,
        `nick=${message.nick}`,
        `query=${resolvedWithFollowups.queryText}`,
      );
    }

    logger.debug(
      "Resolved direct command",
      `arc=${message.serverTag}#${message.channelName}`,
      `mode=${resolvedWithFollowups.modeKey}`,
      `trigger=${resolvedWithFollowups.selectedTrigger}`,
      `model=${modelSpec}`,
      `context_disabled=${resolvedWithFollowups.noContext}`,
    );

    const steeringEnabled =
      Boolean(resolvedWithFollowups.runtime.steering) && !resolvedWithFollowups.noContext;

    const initialSteeringMessages = steeringEnabled && steeringContextDrainer
      ? steeringContextDrainer()
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
      this.deps.chronicleStore
    ) {
      prependedContext = await this.deps.chronicleStore.getChapterContextMessages(
        `${message.serverTag}#${message.channelName}`,
      );
    }

    let selectedContext = (resolvedWithFollowups.noContext ? context.slice(-1) : context).slice(
      -resolvedWithFollowups.runtime.historySize,
    );

    if (
      !resolvedWithFollowups.noContext &&
      resolvedWithFollowups.runtime.autoReduceContext &&
      this.deps.contextReducer.isConfigured &&
      selectedContext.length > 1
    ) {
      const fullContext = [...prependedContext, ...selectedContext];
      const reducedContext = await this.deps.contextReducer.reduce(fullContext, systemPrompt);
      prependedContext = [];
      selectedContext = [
        ...reducedContext,
        selectedContext[selectedContext.length - 1],
      ];
    }

    const runnerContext = [
      ...prependedContext,
      ...selectedContext.slice(0, -1),
      ...initialSteeringMessages,
    ].map(toRunnerContextMessage);

    const tools = this.selectTools(message, resolvedWithFollowups.runtime.allowedTools, runnerContext);

    const steeringMessageProvider = steeringEnabled && steeringContextDrainer
      ? () => steeringContextDrainer().map((msg) => ({
          role: "user" as const,
          content: msg.content,
        }))
      : undefined;

    const runner = this.deps.runnerFactory({
      model: modelSpec,
      systemPrompt,
      tools,
      steeringMessageProvider,
      logger,
    });

    let agentResult: PromptResult;
    try {
      agentResult = await runner.prompt(resolvedWithFollowups.queryText, {
        contextMessages: runnerContext,
        thinkingLevel: normalizeThinkingLevel(resolvedWithFollowups.runtime.reasoningEffort),
        visionFallbackModel: resolvedWithFollowups.runtime.visionModel ?? undefined,
        refusalFallbackModel: this.deps.refusalFallbackModel ?? undefined,
      });

      await this.persistToolSummaryFromSession(message, agentResult, tools as MuaddibTool[]);
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
        `mode=${resolvedWithFollowups.selectedLabel}`,
        `trigger=${resolvedWithFollowups.selectedTrigger}`,
      );
    }

    return {
      response: cleaned || null,
      resolved: resolvedWithFollowups,
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

    const { history, logger } = this.deps;
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

    const { history, logger } = this.deps;
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
    const modeConfig = this.deps.commandConfig.modes[mode];
    if (!modeConfig) {
      throw new Error(`Command mode '${mode}' not found in config`);
    }

    let promptTemplate = modeConfig.prompt ?? "You are {mynick}. Current time: {current_time}.";

    const triggerModelVars: Record<string, string> = {};
    for (const [trigger, modeKey] of Object.entries(this.deps.resolver.triggerToMode)) {
      const triggerOverrideModel = this.deps.resolver.triggerOverrides[trigger]?.model as string | undefined;
      const effectiveModel =
        triggerOverrideModel ??
        (modeKey === mode && modelOverride ? modelOverride : pickModeModel(this.deps.commandConfig.modes[modeKey].model));
      triggerModelVars[`${trigger}_model`] = modelStrCore(effectiveModel ?? "");
    }

    promptTemplate = promptTemplate.replace(
      /\{(![A-Za-z][\w-]*_model)\}/g,
      (_full, key: string) => triggerModelVars[key] ?? _full,
    );

    const promptVars = this.deps.promptVars ?? {};
    const vars: Record<string, string> = {
      ...promptVars,
      mynick,
      current_time: formatCurrentTime(),
    };

    return promptTemplate.replace(/\{([A-Za-z0-9_]+)\}/g, (full, key: string) => vars[key] ?? full);
  }

  async triggerAutoChronicler(message: RoomMessage, maxSize: number): Promise<void> {
    if (!this.deps.autoChronicler) {
      return;
    }

    await this.deps.autoChronicler.checkAndChronicle(
      message.mynick,
      message.serverTag,
      message.channelName,
      maxSize,
    );
  }

  private async collectDebouncedFollowups(
    message: RoomMessage,
    context: Array<{ role: string; content: string }>,
  ): Promise<string[]> {
    const debounceSeconds = numberWithDefault(this.deps.commandConfig.debounce, 0);
    if (debounceSeconds <= 0) {
      return [];
    }

    const originalTimestamp = Date.now() / 1000;
    await sleep(debounceSeconds * 1000);

    const followups = await this.deps.history.getRecentMessagesSince(
      message.serverTag,
      message.channelName,
      message.nick,
      originalTimestamp,
      message.threadId,
    );

    const followupMessages = followups.map((entry) => entry.message).filter((entry) => entry.length > 0);
    if (followupMessages.length > 0) {
      this.deps.logger.debug("Debounced followup messages", `count=${followupMessages.length}`, `nick=${message.nick}`);
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
    if (!this.deps.responseCleaner) {
      return cleaned;
    }
    return this.deps.responseCleaner(cleaned, nick).trim();
  }

  private async applyResponseLengthPolicy(responseText: string): Promise<string> {
    if (!responseText) {
      return responseText;
    }

    const responseBytes = byteLengthUtf8(responseText);
    if (responseBytes <= this.deps.responseMaxBytes) {
      return responseText;
    }

    this.deps.logger.info(
      "Response too long, creating artifact",
      `bytes=${responseBytes}`,
      `max_bytes=${this.deps.responseMaxBytes}`,
    );

    return await this.longResponseToArtifact(responseText);
  }

  private async longResponseToArtifact(fullResponse: string): Promise<string> {
    const artifactResult = await this.deps.shareArtifact(fullResponse);
    const artifactUrl = extractSharedArtifactUrl(artifactResult);

    let trimmed = trimToMaxBytes(fullResponse, this.deps.responseMaxBytes);

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

  private async persistToolSummaryFromSession(
    message: RoomMessage,
    result: PromptResult,
    tools: MuaddibTool[],
  ): Promise<void> {
    if (!this.deps.persistenceSummaryModel) {
      return;
    }

    if (!result.session) {
      return;
    }

    const calls = collectPersistentToolCalls(result.session.messages, tools);
    if (calls.length === 0) {
      return;
    }

    try {
      const summaryResponse = await this.deps.modelAdapter.completeSimple(
        this.deps.persistenceSummaryModel,
        {
          systemPrompt: PERSISTENCE_SUMMARY_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildPersistenceSummaryInput(calls),
              timestamp: Date.now(),
            },
          ],
        },
        {
          callType: "tool_persistence_summary",
          logger: this.deps.logger,
          getApiKey: this.deps.getApiKey,
        },
      );

      const summaryText = summaryResponse.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      if (!summaryText) {
        return;
      }

      const arc = `${message.serverTag}#${message.channelName}`;
      this.deps.logger.debug(
        "Persisting internal monologue summary",
        `arc=${arc}`,
        `chars=${summaryText.length}`,
        `summary=${formatLogPreview(summaryText)}`,
      );

      await this.deps.history.addMessage(
        {
          ...message,
          nick: message.mynick,
          content: summaryText,
        },
        {
          contentTemplate: "[internal monologue] {message}",
        },
      );
    } catch (error) {
      this.deps.logger.error("Failed to generate tool persistence summary", error);
    }
  }

  selectTools(
    message: RoomMessage,
    allowedTools: string[] | null,
    conversationContext?: SessionFactoryContextMessage[],
  ): MuaddibTool[] {
    const invocationToolOptions: BaselineToolOptions = {
      ...this.deps.toolOptions,
      chronicleArc: `${message.serverTag}#${message.channelName}`,
      spritesArc: `${message.serverTag}#${message.channelName}`,
      secrets: message.secrets,
    };

    const baseline = createBaselineAgentTools({
      ...invocationToolOptions,
      onProgressReport: this.deps.onProgressReport,
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

const PERSISTENCE_SUMMARY_SYSTEM_PROMPT =
  "As an AI agent, you need to remember in the future what tools you used when generating a response, and what the tools told you. Summarize all tool uses in a single concise paragraph. If artifact links are included, include every artifact link and tie each link to the corresponding tool call.";

interface PersistentToolCall {
  toolName: string;
  input: unknown;
  output: unknown;
  persistType: ToolPersistType;
  artifactUrls: string[];
}

function collectPersistentToolCalls(messages: AgentMessage[], tools: MuaddibTool[]): PersistentToolCall[] {
  const toolPersistMap = new Map<string, ToolPersistType>();
  for (const tool of tools) {
    toolPersistMap.set(tool.name, tool.persistType);
  }

  return messages
    .filter((message) => message.role === "toolResult")
    .flatMap((message) => {
      const toolResult = message as AgentMessage & {
        toolName: string;
        details?: Record<string, unknown>;
        isError?: boolean;
      };
      if (toolResult.isError) {
        return [];
      }
      const policy = toolPersistMap.get(toolResult.toolName) ?? "none";
      if (policy !== "summary" && policy !== "artifact") {
        return [];
      }

      return [{
        toolName: toolResult.toolName,
        input: toolResult.details?.input,
        output: toolResult,
        persistType: policy,
        artifactUrls: extractArtifactUrls(toolResult),
      }];
    });
}

function buildPersistenceSummaryInput(persistentToolCalls: PersistentToolCall[]): string {
  const lines: string[] = ["The following tool calls were made during this conversation:"];

  for (const call of persistentToolCalls) {
    lines.push(`\n\n# Calling tool **${call.toolName}** (persist: ${call.persistType})`);
    lines.push(`## **Input:**\n${renderPersistenceValue(call.input)}\n`);
    lines.push(`## **Output:**\n${renderPersistenceValue(call.output)}\n`);

    for (const artifactUrl of call.artifactUrls) {
      lines.push(`(Tool call I/O stored as artifact: ${artifactUrl})\n`);
    }
  }

  lines.push("\nPlease provide a concise summary of what was accomplished in these tool calls.");
  return lines.join("\n");
}

function renderPersistenceValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractArtifactUrls(result: unknown): string[] {
  const urls = new Set<string>();

  if (!result || typeof result !== "object") {
    return [];
  }

  const record = result as Record<string, unknown>;
  const details = record.details as Record<string, unknown> | undefined;
  const artifactUrls = details?.artifactUrls;
  if (Array.isArray(artifactUrls)) {
    for (const artifactUrl of artifactUrls) {
      if (typeof artifactUrl === "string" && artifactUrl.trim().length > 0) {
        urls.add(artifactUrl.trim());
      }
    }
  }

  return Array.from(urls);
}

// ── Shared utility functions (exported for command-handler) ──

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

export function toRunnerContextMessage(message: { role: string; content: string }): SessionFactoryContextMessage {
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
  };
}

export function normalizeThinkingLevel(reasoningEffort: string): ThinkingLevel {
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

export function numberWithDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

export function parseResponseMaxBytes(value: unknown): number {
  if (value === undefined || value === null) {
    return 600;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("command.response_max_bytes must be a positive integer.");
  }

  return parsed;
}

export function resolveConfigModelSpec(
  raw: unknown,
  configKey: string,
  _modelAdapter: PiAiModelAdapter,
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

function formatLogPreview(text: string, maxChars = 180): string {
  const singleLine = text.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxChars)}...`;
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
