/**
 * Proactive interjection evaluator.
 *
 * Uses configured validation models to score whether the bot should
 * interject in a conversation.  Returns a simple yes/no + reason.
 */

import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";

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

interface ProactiveEvalLogger {
  debug(message: string, ...data: unknown[]): void;
  info(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
}

export interface ProactiveEvaluatorOptions {
  modelAdapter?: PiAiModelAdapter;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  logger?: ProactiveEvalLogger;
}

/**
 * Evaluate whether the bot should proactively interject based on conversation
 * context.  Runs each validation model in sequence; any score below
 * `(threshold - 1)` causes early rejection.
 */
export async function evaluateProactiveInterjection(
  config: ProactiveConfig,
  context: Array<{ role: string; content: string }>,
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
