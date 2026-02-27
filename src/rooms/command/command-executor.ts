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

} from "./resolver.js";
import type { ProactiveConfig } from "./proactive.js";
import { extractAssistantText, generateToolSummaryFromSession } from "./tool-summary.js";
import type { Logger } from "../../app/logging.js";
import type { AgentConfig, MemoryConfig, SkillsConfig } from "../../config/muaddib-config.js";
import { loadArcMemoryFile } from "../../agent/gondolin/index.js";
import type { ArcEventsWatcher } from "../../events/watcher.js";

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

export interface CommandRunnerFactoryInput {
  model: string;
  systemPrompt: string;
  toolSet: ToolSet;
  metaReminder?: string;
  progressThresholdSeconds?: number;
  progressMinIntervalSeconds?: number;
  onResponse: (text: string) => void | Promise<void>;
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
  usage: Usage | null;
  /** Peak single-turn input tokens (input + cacheRead + cacheWrite) — actual context window fill. */
  peakTurnInput: number;
  toolCallsCount: number;
  /** Deferred work (tool summary, memory update, session dispose) that callers await after sending the response. */
  backgroundWork?: Promise<void>;
}

export interface CommandExecutorOverrides {
  responseCleaner?: (text: string, nick: string) => string;
  runnerFactory?: CommandRunnerFactory;
  rateLimiter?: CommandRateLimiter;
  contextReducer?: ContextReducer;
  eventsWatcher?: ArcEventsWatcher;
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
  private readonly eventsWatcher?: ArcEventsWatcher;

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
          onResponse: input.onResponse,
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

    this.eventsWatcher = overrides?.eventsWatcher;

  }

  private buildToolOptions(): Omit<BaselineToolOptions, "arc" | "onProgressReport"> {
    return {
      toolsConfig: this.agentConfig.tools,
      authStorage: this.runtime.authStorage,
      modelAdapter: this.modelAdapter,
      logger: this.logger,
      eventsWatcher: this.eventsWatcher,
    };
  }

  /**
   * Execute a command: resolve mode, build context, run agent, process result,
   * persist, and deliver response.
   */
  async execute(
    message: RoomMessage,
    triggerTs: string,
    sendResponse: SendResponse,
    onAgentCreated?: (agent: Agent) => void,
    onResponseDelivered?: () => void,
  ): Promise<void> {
    const { commandConfig, logger } = this;
    const defaultSize = commandConfig.historySize;
    const maxSize = Math.max(
      defaultSize,
      ...Object.values(commandConfig.modes).map((mode) => Number(mode.historySize ?? 0)),
    );

    // ── Unified delivery: send + persist (used for all responses) ──
    const deliver = async (text: string, persistOptions?: { cost?: number; mode?: string }): Promise<void> => {
      logger.info("Delivering response", `arc=${message.arc}`, `response=${text}`);
      const sr = await sendResponse(text);
      await this.persistBotResponse(message.arc, message, text, sr ?? undefined, {
        run: triggerTs,
        ...persistOptions,
      });
    };

    // ── Rate limit ──

    if (!this.rateLimiter.checkLimit()) {
      logger.warn("Rate limit triggered", `arc=${message.arc}`, `nick=${message.nick}`);
      await deliver(`${message.nick}: Slow down a little, will you? (rate limiting)`);
      return;
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
      await deliver(`${message.nick}: ${resolved.error}`);
      return;
    }

    if (resolved.helpRequested) {
      logger.debug("Sending help message", `nick=${message.nick}`);
      await deliver(this.resolver.buildHelpMessage(message.serverTag, message.channelName));
      return;
    }

    if (!resolved.modeKey || !resolved.runtime || !resolved.selectedTrigger) {
      await deliver(`${message.nick}: Internal command resolution error.`);
      return;
    }

    const modeConfig = commandConfig.modes[resolved.modeKey];
    const modelSpec =
      resolved.modelOverride ??
      resolved.runtime.model ??
      pickModeModel(modeConfig.model) ??
      null;

    if (!modelSpec) {
      await deliver(`${message.nick}: No model configured for mode '${resolved.modeKey}'.`);
      return;
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

    // Agent response callback: cleans text + applies length policy, then delivers.
    // Used for all agent text (intermediate + final) and progress reports.
    const onResponse = async (text: string): Promise<void> => {
      let cleaned = this.cleanResponseText(text, message.nick);
      cleaned = await this.applyResponseLengthPolicy(cleaned, message.arc);
      await deliver(cleaned, { mode: resolved.selectedTrigger ?? undefined });
    };

    const toolSet = this.selectTools(message, resolved.runtime.allowedTools, runnerContext, onResponse);

    const progressConfig = this.agentConfig.progress;

    const runner = this.runnerFactory({
      model: modelSpec,
      systemPrompt,
      toolSet,
      metaReminder: modeConfig.promptReminder,
      progressThresholdSeconds: progressConfig?.thresholdSeconds,
      progressMinIntervalSeconds: progressConfig?.minIntervalSeconds,
      onResponse,
      logger,
      onAgentCreated,
    });

    const queryTimestamp = formatUtcTime().slice(-5); // HH:MM in UTC, matching history format
    const queryContent = message.originalContent ?? resolved.queryText;
    const { usage, peakTurnInput, toolCallsCount, backgroundWork } = await this.invokeAndPostProcess(
      runner, message, `[${queryTimestamp}] <${message.nick}> ${queryContent}`, runnerContext, toolSet.tools, {
        reasoningEffort: resolved.runtime.reasoningEffort,
        visionModel: resolved.runtime.visionModel ?? undefined,
        memoryUpdate: resolved.runtime.memoryUpdate,
      }, triggerTs,
    );

    // Log the completed agent run with cost/context stats.
    // peakTurnInput (input + cacheRead + cacheWrite for the largest turn) represents
    // actual context window fill; summed usage.input excludes cached tokens.
    const costStr = usage ? `$${usage.cost.total.toFixed(4)}` : "?";
    let ctxStr = peakTurnInput > 0 ? `${Math.round(peakTurnInput / 1000)}k` : "?";
    if (peakTurnInput > 0) {
      try {
        const ctxWindow = this.modelAdapter.resolve(modelSpec).model.contextWindow;
        if (ctxWindow > 0) {
          ctxStr += `/${Math.round(ctxWindow / 1000)}k(${Math.round((peakTurnInput / ctxWindow) * 100)}%)`;
        }
      } catch { /* model resolution may fail for edge cases — keep absolute count */ }
    }

    // Signal that the primary response has been delivered — callers can deregister
    // steering before the potentially long background work begins.
    onResponseDelivered?.();

    // Cost followups, background work, and chronicle run after the response is delivered.
    if (usage) {
      await this.emitCostFollowups(message, usage, toolCallsCount, deliver);
    }

    await backgroundWork;
    await this.triggerAutoChronicler(message, this.commandConfig.historySize);

    logger.info(
      "Agent run complete",
      `arc=${message.arc}`,
      `mode=${resolved.selectedLabel ?? "n/a"}`,
      `trigger=${resolved.selectedTrigger ?? "n/a"}`,
      `ctx=${ctxStr}`,
      `cost=${costStr}`,
    );
  }

  /**
   * Execute a proactive interjection in serious mode with extra prompt.
   * Returns true if a response was actually sent.
   *
   * Proactive responses send only model text outputs — no progress reports,
   * no error messages to the room.
   */
  async executeProactive(
    message: RoomMessage,
    sendResponse: SendResponse,
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

    const proactiveProgressConfig = this.agentConfig.progress;

    // Proactive delivery: prefix with model tag, send + persist.
    const deliver = async (text: string): Promise<void> => {
      const sr = await sendResponse(text);
      await this.persistBotResponse(message.arc, message, text, sr ?? undefined, {
        mode: classifiedTrigger,
      });
    };

    // Proactive agent response: cleans text, prefixes with model tag, then delivers.
    // Progress reports are intentionally excluded — only model text outputs are sent.
    // NULL sentinels and error prefixes are suppressed here so they never reach the room.
    let proactiveDelivered = false;
    const onResponse = async (text: string): Promise<void> => {
      let cleaned = this.cleanResponseText(text, message.nick);
      cleaned = await this.applyResponseLengthPolicy(cleaned, message.arc);
      if (!cleaned || isNullSentinel(cleaned) || cleaned.startsWith("Error: ")) return;
      proactiveDelivered = true;
      await deliver(`[${modelStrCore(modelSpec)}] ${cleaned}`);
    };

    // selectTools is called WITHOUT onResponse as onProgressReport — proactive
    // sessions must not flood the room with tool progress messages.
    const toolSet = this.selectTools(message, classifiedRuntime.allowedTools, runnerContext);

    const runner = this.runnerFactory({
      model: modelSpec,
      systemPrompt,
      toolSet,
      metaReminder: this.commandConfig.modes.serious?.promptReminder,
      progressThresholdSeconds: proactiveProgressConfig?.thresholdSeconds,
      progressMinIntervalSeconds: proactiveProgressConfig?.minIntervalSeconds,
      onResponse,
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

    // onResponse already filters NULL sentinels, errors, and empty text —
    // check whether anything was actually delivered to the room.
    if (!proactiveDelivered) {
      logger.info("Agent decided not to interject proactively", `arc=${message.arc}`);
      await result.backgroundWork;
      return false;
    }

    await result.backgroundWork;
    await this.triggerAutoChronicler(message, this.commandConfig.historySize);

    logger.info(
      "Proactive response delivered",
      `arc=${message.arc}`,
      `trigger=${classifiedTrigger}`,
    );
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

    // Deferred: memory update, tool summary persistence, session dispose.
    // Memory update runs first so that any tool calls it produces (write/edit
    // to MEMORY.md) and model reasoning are captured in the persistence summary.
    // Callers await this *after* sending the response so the user isn't blocked.
    const backgroundWork = (async () => {
      // Stop delivering text to the channel — anything produced from here on
      // (memory update, tool summary) is internal background work.
      agentResult.muteResponses?.();
      let memoryUpdateText: string | undefined;

      if (opts.memoryUpdate !== false && agentResult.session) {
        const preMemoryMsgCount = agentResult.session.messages.length;
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
        // Collect assistant text produced during memory update for the summary.
        memoryUpdateText = extractAssistantText(
          agentResult.session.messages.slice(preMemoryMsgCount),
        );
      }

      await this.persistGeneratedToolSummary(message, agentResult, tools, triggerTs, memoryUpdateText);

      agentResult.session?.dispose();
    })();

    return {
      usage: agentResult.usage,
      peakTurnInput: agentResult.peakTurnInput,
      toolCallsCount: agentResult.toolCallsCount ?? 0,
      backgroundWork,
    };
  }

  // ── Cost followups ──

  /**
   * Emit cost followup and daily milestone messages after an agent run.
   *
   * The cost is recorded in the JSONL via the cost followup persist (cost > 0.2).
   * Small costs (≤ 0.2) are not stored individually; they're too small to shift
   * a whole-dollar milestone boundary on their own.
   *
   * `deliver` is the same send+persist closure used for all other responses,
   * ensuring cost messages are logged and persisted consistently.
   */
  private async emitCostFollowups(
    message: RoomMessage,
    usage: Usage,
    toolCallsCount: number,
    deliver: (text: string, opts?: { cost?: number }) => Promise<void>,
  ): Promise<void> {
    const { history, logger } = this;
    const arcName = message.arc;
    const totalCost = usage.cost.total;
    if (!(totalCost > 0)) {
      return;
    }

    if (totalCost > 0.2) {
      const costMessage = `(${[
        `this message used ${toolCallsCount} tool calls`,
        `${usage.input + usage.cacheRead + usage.cacheWrite} in / ${usage.output} out tokens`,
        `and cost $${totalCost.toFixed(4)}`,
      ].join(", ")})`;

      logger.info("Sending cost followup", `arc=${arcName}`, `cost=${totalCost.toFixed(4)}`);
      // Pass cost so getArcCostToday includes it for the milestone check below.
      await deliver(costMessage, { cost: totalCost });
    }
    // Costs ≤ $0.20 are not stored (no followup message sent).
    // They're too small to trigger a whole-dollar milestone on their own,
    // so the milestone check below remains accurate in practice.

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
    await deliver(milestoneMessage);
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
      current_time: formatUtcTime() + " UTC",
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
    memoryUpdateText?: string,
  ): Promise<void> {
    const summaryText = await generateToolSummaryFromSession({
      result,
      tools,
      persistenceSummaryModel: this.persistenceSummaryModel,
      modelAdapter: this.modelAdapter,
      logger: this.logger,
      arc: message.arc,
      memoryUpdateText,
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
    onResponse?: (text: string) => void | Promise<void>,
  ): ToolSet {
    const invocationToolOptions: BaselineToolOptions = {
      ...this.buildToolOptions(),
      arc: message.arc,
      secrets: message.secrets,
    };

    const toolSet = createBaselineAgentTools({
      ...invocationToolOptions,
      onProgressReport: onResponse,
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

// ── Shared utility functions (exported for message-handler) ──

export function modelStrCore(model: unknown): string {
  return String(model).replace(/(?:[-.\w]*:)?(?:[-.\w]*\/)?([-.\w]+)(?:#[-\w,/]*)?/, "$1");
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
  const content = loadArcMemoryFile(arc);

  const chars = content.length;
  const capacityWarning = chars >= charLimit * 0.8
    ? " - you must consolidate existing entries if you add something"
    : "";

  const displayContent = content.trim() || "(empty - not yet created)";

  let prompt = `<meta>Session complete. DO NOT RESPOND ANYMORE.\n\nWrap-up task: Here is your current /workspace/MEMORY.md (${chars}/${charLimit} chars${capacityWarning}):\n---\n${displayContent}\n---\nIf you learned something worth persisting for the long term (beyond the continuously moving chronicle: user preferences, big lessons, key decisions), update /workspace/MEMORY.md using the edit or write tool. Keep entries concise. If nothing worth saving, do nothing.`;

  // Skill creation section - appended when session was complex enough
  const toolCallsCount = options?.toolCallsCount ?? 0;
  const threshold = options?.skillsConfig?.creationThreshold ?? DEFAULT_SKILL_CREATION_THRESHOLD;

  if (toolCallsCount >= threshold) {
    prompt += `\n\nSkill creation: this session used ${toolCallsCount} tool calls - was it tough? If you didn't follow an existing skill, consider saving a reusable skill using manage-skills. Skills allow you to continuously learn, but also carry a permanent token cost. So only if both:\n- The procedure was complex *and* hard to discover (required trial & error or user correction)\n- You could confirm this is a pattern you've encountered historically (grep history?) or are certain to need again\nIf it's not worth capturing, do nothing.`;
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
