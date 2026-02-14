import { type UserMessage } from "@mariozechner/pi-ai";

import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import type { CommandConfig } from "./resolver.js";

interface ModeClassifierLogger {
  debug(message: string, ...data: unknown[]): void;
  info(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
}

export interface ModeClassifierOptions {
  modelAdapter: PiAiModelAdapter;
  logger?: ModeClassifierLogger;
}

export function createModeClassifier(
  commandConfig: CommandConfig,
  options: ModeClassifierOptions,
): (context: Array<{ role: string; content: string }>) => Promise<string> {
  const adapter = options.modelAdapter;
  const logger = options.logger ?? noopModeClassifierLogger();

  return async (context: Array<{ role: string; content: string }>): Promise<string> => {
    const fallbackLabel =
      commandConfig.mode_classifier.fallback_label ??
      Object.keys(commandConfig.mode_classifier.labels)[0];

    if (context.length === 0) {
      logger.error("Error classifying mode", "context is empty");
      return fallbackLabel;
    }

    try {
      const llmMessages = context.map<UserMessage>((entry) => ({
        role: "user",
        content:
          entry.role === "assistant" ? `[assistant] ${entry.content}` : entry.content,
        timestamp: Date.now(),
      }));

      const currentMessage = extractCurrentMessage(context[context.length - 1].content);
      const labels = Object.keys(commandConfig.mode_classifier.labels);
      const classifierPrompt =
        commandConfig.mode_classifier.prompt ??
        `Analyze the latest message and pick exactly one label: ${labels.join(", ")}. Message: {message}`;

      const prompt = classifierPrompt.replace("{message}", currentMessage);

      const response = await adapter.completeSimple(
        commandConfig.mode_classifier.model,
        {
          messages: llmMessages,
          systemPrompt: `${prompt}\n\nReturn exactly one classifier label token. No explanation. If uncertain, pick the best label.`,
        },
        {
          callType: "mode_classifier",
          logger,
          streamOptions: { reasoning: "minimal" },
        },
      );

      const responseText = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ")
        .trim();
      const normalizedText = responseText.toUpperCase();

      const counts = new Map<string, number>();
      for (const label of labels) {
        counts.set(label, countOccurrences(normalizedText, label.toUpperCase()));
      }

      let bestLabel = fallbackLabel;
      let bestCount = 0;
      for (const [label, count] of counts.entries()) {
        if (count > bestCount) {
          bestLabel = label;
          bestCount = count;
        }
      }

      if (bestCount === 0) {
        logger.warn("Invalid mode classification response", `response=${responseText}`);
        return fallbackLabel;
      }

      return bestLabel;
    } catch (error) {
      logger.error("Error classifying mode", error);
      return fallbackLabel;
    }
  };
}

function extractCurrentMessage(content: string): string {
  const match = content.match(/<[^>]+>\s*(.*)$/);
  return match ? match[1].trim() : content;
}

function countOccurrences(text: string, token: string): number {
  if (!token) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(token, index);
    if (index < 0) {
      return count;
    }
    count += 1;
    index += token.length;
  }
}

function noopModeClassifierLogger(): ModeClassifierLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}
