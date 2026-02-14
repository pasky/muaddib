/**
 * Proactive interjection — evaluation and lifecycle runner.
 *
 * The evaluator uses configured validation models to score whether the bot
 * should interject in a conversation.  The runner owns the full proactive
 * lifecycle: config resolution, channel matching, rate limiting, debounce
 * loop, evaluation, and delegation to the executor for actual interjection.
 */

import type { ChatRole } from "../../history/chat-history-store.js";
import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import type { ProactiveRoomConfig } from "../../config/muaddib-config.js";
import type { MuaddibRuntime } from "../../runtime.js";
import type { CommandConfig } from "./resolver.js";
import { CommandResolver } from "./resolver.js";
import { RateLimiter } from "./rate-limiter.js";
import type {
  CommandExecutor,
  CommandRateLimiter,
  CommandExecutorLogger,
} from "./command-executor.js";
import { pickModeModel } from "./command-executor.js";
import type { SteeringQueue, QueuedInboundMessage, SteeringKey } from "./steering-queue.js";
import type { RoomMessage } from "../message.js";

// ── ProactiveConfig (resolved, all fields required) ──

export interface ProactiveConfig {
  /** Channels where proactive interjection is enabled (e.g. "irc.libera.chat#channel"). */
  interjecting: string[];
  /** Debounce period in seconds — wait for silence before evaluating. */
  debounce_seconds: number;
  /** History size for proactive context. */
  history_size: number;
  /** Rate limit: max interjections per rate_period. */
  rate_limit: number;
  /** Rate period in seconds. */
  rate_period: number;
  /** Minimum score (out of 10) to trigger interjection. */
  interject_threshold: number;
  /** Model to use when interjecting (for "serious" mode). */
  models: {
    /** Validation models — scored in sequence, early-exit on low score. */
    validation: string[];
    /** Model to use for the actual serious-mode interjection. */
    serious: string;
  };
  prompts: {
    /** Prompt template for interject evaluation. Use {message} placeholder. */
    interject: string;
    /** Extra prompt appended to the serious system prompt for proactive runs. */
    serious_extra: string;
  };
}

export interface ProactiveEvalResult {
  shouldInterject: boolean;
  reason: string;
}

export interface ProactiveEvaluatorOptions {
  modelAdapter?: PiAiModelAdapter;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  logger?: CommandExecutorLogger;
}

// ── Config builder ──

/**
 * Build a resolved ProactiveConfig from raw room config, or return null
 * if proactive interjection is not configured.
 */
export function buildProactiveConfig(
  rawProactive: ProactiveRoomConfig | undefined,
  commandConfig: CommandConfig,
): ProactiveConfig | null {
  const interjecting = rawProactive?.interjecting;
  if (!rawProactive || !interjecting || interjecting.length === 0) {
    return null;
  }
  return {
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
}

// ── ProactiveRunner ──

/**
 * Owns the full proactive interjection lifecycle: config, channel matching,
 * rate limiting, debounce loop, scoring evaluation, and delegation to the
 * executor for the actual agent run.
 */
export class ProactiveRunner {
  private readonly config: ProactiveConfig;
  private readonly channels: Set<string>;
  private readonly rateLimiter: CommandRateLimiter;
  private readonly runtime: MuaddibRuntime;
  private readonly logger: CommandExecutorLogger;
  private readonly executor: CommandExecutor;
  private readonly resolver: CommandResolver;
  private readonly steeringQueue: SteeringQueue;

  constructor(opts: {
    config: ProactiveConfig;
    runtime: MuaddibRuntime;
    logger: CommandExecutorLogger;
    executor: CommandExecutor;
    resolver: CommandResolver;
    steeringQueue: SteeringQueue;
  }) {
    this.config = opts.config;
    this.channels = new Set(opts.config.interjecting);
    this.rateLimiter = new RateLimiter(opts.config.rate_limit, opts.config.rate_period);
    this.runtime = opts.runtime;
    this.logger = opts.logger;
    this.executor = opts.executor;
    this.resolver = opts.resolver;
    this.steeringQueue = opts.steeringQueue;
  }

  /** Check whether a channel key is proactive-enabled. */
  isProactiveChannel(channelKey: string): boolean {
    return this.channels.has(channelKey);
  }

  /**
   * Run a proactive session: debounce, evaluate, and possibly interject.
   * Takes ownership of the steering session lifecycle.
   */
  async runSession(
    steeringKey: SteeringKey,
    triggerItem: QueuedInboundMessage,
  ): Promise<void> {
    const debounceMs = this.config.debounce_seconds * 1000;
    const contextDrainer = this.steeringQueue.createContextDrainer(steeringKey);
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
        await this.evaluateAndMaybeInterject(
          triggerItem.message, triggerItem.sendResponse, contextDrainer,
        );
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
          contextDrainer,
        );
      } else {
        await this.evaluateAndMaybeInterject(
          activeItem.message, activeItem.sendResponse, contextDrainer,
        );
        activeItem.result = null;
      }

      this.steeringQueue.finishItem(activeItem);

      // Drain remaining items in the session
      await this.steeringQueue.drainSession(steeringKey, async (item, drainer) => {
        if (item.kind === "command") {
          if (item.triggerMessageId === null) {
            throw new Error("Queued command item is missing trigger message id.");
          }
          item.result = await this.executor.execute(
            item.message,
            item.triggerMessageId,
            item.sendResponse,
            drainer,
          );
        } else {
          await this.executor.triggerAutoChronicler(item.message);
          item.result = null;
        }
      });
    } catch (error) {
      this.steeringQueue.abortSession(steeringKey, error);
      if (activeItem) {
        this.steeringQueue.failItem(activeItem, error);
      }
      throw error;
    }
  }

  private async evaluateAndMaybeInterject(
    message: RoomMessage,
    sendResponse: ((text: string) => Promise<void>) | undefined,
    contextDrainer: () => Array<{ role: ChatRole; content: string }>,
  ): Promise<void> {
    if (!this.rateLimiter.checkLimit()) {
      this.logger.debug(
        "Proactive interjection rate limited",
        `arc=${message.serverTag}#${message.channelName}`,
        `nick=${message.nick}`,
      );
      return;
    }

    const context = await this.runtime.history.getContextForMessage(
      message,
      this.config.history_size,
    );

    const evalResult = await evaluateProactiveInterjection(
      this.config,
      context,
      {
        modelAdapter: this.runtime.modelAdapter,
        getApiKey: this.runtime.getApiKey,
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

    const classifiedLabel = await this.executor.classifyMode(context);
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
      this.config,
      classifiedTrigger,
      classifiedRuntime,
      contextDrainer,
    );
  }
}

// ── Evaluation function ──

/**
 * Evaluate whether the bot should proactively interject based on conversation
 * context.  Runs each validation model in sequence; any score below
 * `(threshold - 1)` causes early rejection.
 */
export async function evaluateProactiveInterjection(
  config: ProactiveConfig,
  context: Array<{ role: ChatRole; content: string }>,
  options: ProactiveEvaluatorOptions = {},
): Promise<ProactiveEvalResult> {
  const adapter = options.modelAdapter ?? new PiAiModelAdapter();
  const logger = options.logger;

  if (!context.length) {
    return { shouldInterject: false, reason: "No context provided" };
  }

  const currentMessage = extractCurrentMessage(context[context.length - 1].content);
  const prompt = config.prompts.interject.replace("{message}", currentMessage);
  const validationModels = config.models.validation;

  try {
    let finalScore: number | null = null;

    for (let i = 0; i < validationModels.length; i++) {
      const model = validationModels[i];
      const response = await adapter.completeSimple(
        model,
        {
          messages: context.map((entry) => ({
            role: "user" as const,
            content: entry.role === "assistant" ? `[assistant] ${entry.content}` : entry.content,
            timestamp: Date.now(),
          })),
          systemPrompt: prompt,
        },
        {
          callType: "proactive_validation",
          logger: logger ?? { debug() {}, info() {}, warn() {}, error() {} },
          getApiKey: options.getApiKey,
          streamOptions: { reasoning: "minimal" },
        },
      );

      const responseText = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ")
        .trim();

      if (!responseText) {
        return { shouldInterject: false, reason: `No response from validation model ${i + 1}` };
      }

      const scoreMatch = responseText.match(/(\d+)\/10/);
      if (!scoreMatch) {
        logger?.warn(
          "No valid score in proactive response",
          `model=${model}`,
          `step=${i + 1}`,
          `response=${responseText}`,
        );
        return { shouldInterject: false, reason: `No score found in validation step ${i + 1}` };
      }

      const score = Number(scoreMatch[1]);
      finalScore = score;

      logger?.debug(
        "Proactive validation step",
        `step=${i + 1}/${validationModels.length}`,
        `model=${model}`,
        `score=${score}`,
      );

      if (score < config.interject_threshold - 1) {
        if (i > 0) {
          logger?.info(
            "Proactive interjection rejected",
            `step=${i + 1}/${validationModels.length}`,
            `message=${currentMessage.slice(0, 150)}`,
            `score=${score}`,
          );
        } else {
          logger?.debug(
            "Proactive interjection rejected",
            `step=${i + 1}/${validationModels.length}`,
            `score=${score}`,
          );
        }
        return {
          shouldInterject: false,
          reason: `Rejected at validation step ${i + 1} (Score: ${score})`,
        };
      }
    }

    if (finalScore !== null && finalScore >= config.interject_threshold) {
      logger?.debug(
        "Proactive interjection triggered",
        `message=${currentMessage.slice(0, 150)}`,
        `score=${finalScore}`,
      );
      return {
        shouldInterject: true,
        reason: `Interjection decision (Final Score: ${finalScore})`,
      };
    }

    return {
      shouldInterject: false,
      reason: finalScore !== null
        ? `No interjection (Final Score: ${finalScore})`
        : "No valid final score",
    };
  } catch (error) {
    logger?.error("Error checking proactive interjection", error);
    return { shouldInterject: false, reason: `Error: ${String(error)}` };
  }
}

function extractCurrentMessage(content: string): string {
  const match = content.match(/<?\S+>\s*(.*)/);
  return match ? match[1].trim() : content;
}
