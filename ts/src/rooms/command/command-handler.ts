import type { AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Usage } from "@mariozechner/pi-ai";

import {
  MuaddibAgentRunner,
  type MuaddibAgentRunnerOptions,
  type RunnerContextMessage,
  type SingleTurnResult,
} from "../../agent/muaddib-agent-runner.js";
import {
  createBaselineAgentTools,
  type BaselineToolOptions,
} from "../../agent/tools/baseline-tools.js";
import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import { parseModelSpec } from "../../models/model-spec.js";
import { RateLimiter } from "./rate-limiter.js";
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

export interface CommandHandlerRoomConfig {
  command: CommandConfig;
  prompt_vars?: Record<string, string>;
}

export interface CommandRunner {
  runSingleTurn(
    prompt: string,
    options?: { contextMessages?: RunnerContextMessage[]; thinkingLevel?: ThinkingLevel },
  ): Promise<SingleTurnResult>;
}

export interface CommandRunnerFactoryInput {
  model: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
}

export type CommandRunnerFactory = (input: CommandRunnerFactoryInput) => CommandRunner;

export interface CommandRateLimiter {
  checkLimit(): boolean;
}

export interface CommandHandlerOptions {
  roomConfig: CommandHandlerRoomConfig;
  history: ChatHistoryStore;
  classifyMode: (context: Array<{ role: string; content: string }>) => Promise<string>;
  runnerFactory?: CommandRunnerFactory;
  rateLimiter?: CommandRateLimiter;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  refusalFallbackModel?: string;
  responseCleaner?: (text: string, nick: string) => string;
  helpToken?: string;
  flagTokens?: string[];
  onProgressReport?: (text: string) => void | Promise<void>;
  toolOptions?: Omit<BaselineToolOptions, "onProgressReport">;
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
  private readonly refusalFallbackModel: string | null;

  constructor(private readonly options: CommandHandlerOptions) {
    this.commandConfig = options.roomConfig.command;

    this.resolver = new CommandResolver(
      this.commandConfig,
      options.classifyMode,
      options.helpToken ?? "!h",
      new Set(options.flagTokens ?? ["!c"]),
      modelStrCore,
    );

    this.runnerFactory =
      options.runnerFactory ??
      ((input) =>
        new MuaddibAgentRunner({
          model: input.model,
          systemPrompt: input.systemPrompt,
          tools: input.tools,
          getApiKey: options.getApiKey,
          maxIterations: options.agentLoop?.maxIterations,
          maxCompletionRetries: options.agentLoop?.maxCompletionRetries,
          emptyCompletionRetryPrompt: options.agentLoop?.emptyCompletionRetryPrompt,
        } as MuaddibAgentRunnerOptions));

    this.refusalFallbackModel = options.refusalFallbackModel
      ? normalizeModelSpec(options.refusalFallbackModel)
      : null;

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
      await this.handlePassiveMessage(message, options.sendResponse);
      return null;
    }

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
      return this.rateLimitedResult(message);
    }

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
      return {
        response: `${message.nick}: ${resolvedWithFollowups.error}`,
        resolved: resolvedWithFollowups,
        model: null,
        usage: null,
      };
    }

    if (resolvedWithFollowups.helpRequested) {
      return {
        response: this.resolver.buildHelpMessage(message.serverTag, message.channelName),
        resolved: resolvedWithFollowups,
        model: null,
        usage: null,
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
      };
    }

    const steeringMessages =
      resolvedWithFollowups.runtime.steering && !resolvedWithFollowups.noContext
        ? this.steeringQueue.drainSteeringContextMessages(steeringKey)
        : [];

    const selectedContext = (resolvedWithFollowups.noContext ? context.slice(-1) : context).slice(
      -resolvedWithFollowups.runtime.historySize,
    );

    // The trigger message will be sent as the new prompt for this turn.
    // Keep only prior context from history here to avoid sending the trigger twice.
    const runnerContext = [
      ...selectedContext.slice(0, -1),
      ...steeringMessages,
    ].map(toRunnerContextMessage);

    const systemPrompt = this.buildSystemPrompt(
      resolvedWithFollowups.modeKey,
      message.mynick,
      resolvedWithFollowups.modelOverride ?? undefined,
    );

    const tools = this.selectTools(resolvedWithFollowups.runtime.allowedTools);

    const runResult = await this.runWithRefusalFallback(
      modelSpec,
      {
        prompt: resolvedWithFollowups.queryText,
        contextMessages: runnerContext,
        thinkingLevel: normalizeThinkingLevel(resolvedWithFollowups.runtime.reasoningEffort),
      },
      {
        systemPrompt,
        tools,
      },
    );

    let cleaned = this.cleanResponseText(runResult.agentResult.text, message.nick);
    if (runResult.fallbackModelSpec) {
      const fallbackSpec = parseModelSpec(runResult.fallbackModelSpec);
      cleaned = `${cleaned} [refusal fallback to ${fallbackSpec.modelId}]`.trim();
    }

    return {
      response: cleaned || null,
      resolved: resolvedWithFollowups,
      model: runResult.modelSpec,
      usage: runResult.agentResult.usage,
    };
  }

  private async runWithRefusalFallback(
    primaryModelSpec: string,
    runInput: {
      prompt: string;
      contextMessages: RunnerContextMessage[];
      thinkingLevel: ThinkingLevel;
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
    });

    let primaryResult: SingleTurnResult;

    try {
      primaryResult = await primaryRunner.runSingleTurn(runInput.prompt, {
        contextMessages: runInput.contextMessages,
        thinkingLevel: runInput.thinkingLevel,
      });
    } catch (error) {
      const refusalSignal = detectRefusalFallbackSignal(stringifyError(error));
      if (!refusalSignal || !this.refusalFallbackModel) {
        throw error;
      }

      const fallbackResult = await this.runFallbackModelTurn(this.refusalFallbackModel, runInput, runnerInput);
      return {
        ...fallbackResult,
        fallbackModelSpec: this.refusalFallbackModel,
      };
    }

    const refusalSignal = detectRefusalFallbackSignal(primaryResult.text);
    if (!refusalSignal || !this.refusalFallbackModel) {
      return {
        agentResult: primaryResult,
        modelSpec: primaryModelSpec,
        fallbackModelSpec: null,
      };
    }

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
    });

    const fallbackResult = await fallbackRunner.runSingleTurn(runInput.prompt, {
      contextMessages: runInput.contextMessages,
      thinkingLevel: runInput.thinkingLevel,
    });

    return {
      agentResult: fallbackResult,
      modelSpec: fallbackModelSpec,
      fallbackModelSpec: null,
    };
  }

  private async executeAndPersist(
    message: RoomMessage,
    triggerMessageId: number,
    sendResponse: ((text: string) => Promise<void>) | undefined,
    steeringKey: SteeringKey,
  ): Promise<CommandExecutionResult> {
    const result = await this.executeWithSteering(message, steeringKey);
    await this.persistExecutionResult(message, triggerMessageId, result, sendResponse);
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

    let llmCallId: number | null = null;
    if (result.model && result.usage) {
      const spec = parseModelSpec(result.model);
      llmCallId = await this.options.history.logLlmCall({
        provider: spec.provider,
        model: spec.modelId,
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        cost: result.usage.cost.total,
        callType: "agent_run",
        arcName: `${message.serverTag}#${message.channelName}`,
        triggerMessageId,
      });
    }

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
    _message: RoomMessage,
    _sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<void> {
    // Proactive/chronicling passive handling stays out of scope in TS parity v1.
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
    };
  }

  private cleanResponseText(text: string, nick: string): string {
    const cleaned = text.trim();
    if (!this.options.responseCleaner) {
      return cleaned;
    }
    return this.options.responseCleaner(cleaned, nick).trim();
  }

  private selectTools(allowedTools: string[] | null): AgentTool<any>[] {
    const baseline = createBaselineAgentTools({
      ...this.options.toolOptions,
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
