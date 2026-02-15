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
  debounceSeconds: number;
  /** History size for proactive context. */
  historySize: number;
  /** Rate limit: max interjections per ratePeriod. */
  rateLimit: number;
  /** Rate period in seconds. */
  ratePeriod: number;
  /** Minimum score (out of 10) to trigger interjection. */
  interjectThreshold: number;
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
    seriousExtra: string;
  };
}

export interface ProactiveEvalResult {
  shouldInterject: boolean;
  reason: string;
}

export interface ProactiveEvaluatorOptions {
  modelAdapter: PiAiModelAdapter;
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
    debounceSeconds: rawProactive.debounceSeconds ?? 15,
    historySize: rawProactive.historySize ?? commandConfig.historySize,
    rateLimit: rawProactive.rateLimit ?? 10,
    ratePeriod: rawProactive.ratePeriod ?? 3600,
    interjectThreshold: rawProactive.interjectThreshold ?? 7,
    models: {
      validation: rawProactive.models?.validation ?? [],
      serious: rawProactive.models?.serious ?? pickModeModel(commandConfig.modes.serious?.model) ?? "",
    },
    prompts: {
      interject: rawProactive.prompts?.interject ?? "",
      seriousExtra: rawProactive.prompts?.seriousExtra ?? "",
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
    this.rateLimiter = new RateLimiter(opts.config.rateLimit, opts.config.ratePeriod);
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
    const debounceMs = this.config.debounceSeconds * 1000;
    const contextDrainer = this.steeringQueue.createContextDrainer(steeringKey);
    this.steeringQueue.finishItem(triggerItem);

    try {
      // ── Debounce loop: wait for silence ──
      while (true) {
        const result = await this.steeringQueue.waitForNewItem(steeringKey, debounceMs);

        if (result === "timeout") {
          break;
        }

        if (this.steeringQueue.hasQueuedCommands(steeringKey)) {
          // Command arrived — release session so it retries as new runner.
          this.steeringQueue.releaseSession(steeringKey);
          return;
        }

        this.steeringQueue.drainSteeringContextMessages(steeringKey);
      }

      // Silence achieved — evaluate and maybe interject.
      await this.evaluateAndMaybeInterject(
        triggerItem.message, triggerItem.sendResponse, contextDrainer,
      );
      this.steeringQueue.releaseSession(steeringKey);
    } catch (error) {
      this.steeringQueue.abortSession(steeringKey, error);
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
      this.config.historySize,
    );

    const evalResult = await evaluateProactiveInterjection(
      this.config,
      context,
      {
        modelAdapter: this.runtime.modelAdapter,
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
  options: ProactiveEvaluatorOptions,
): Promise<ProactiveEvalResult> {
  const adapter = options.modelAdapter;
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

      if (score < config.interjectThreshold - 1) {
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

    if (finalScore !== null && finalScore >= config.interjectThreshold) {
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
