import { type UserMessage, type AssistantMessage, type Message } from "@mariozechner/pi-ai";

import { NOOP_LOGGER, type Logger } from "../../app/logging.js";
import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import type { CommandConfig } from "./resolver.js";

export interface ModeClassifierOptions {
  modelAdapter: PiAiModelAdapter;
  logger?: Logger;
}

export function createModeClassifier(
  commandConfig: CommandConfig,
  options: ModeClassifierOptions,
): (context: Array<{ role: string; content: string }>) => Promise<string> {
  const adapter = options.modelAdapter;
  const logger = options.logger ?? NOOP_LOGGER;

  return async (context: Array<{ role: string; content: string }>): Promise<string> => {
    const fallbackLabel =
      commandConfig.modeClassifier.fallbackLabel ??
      Object.keys(commandConfig.modeClassifier.labels)[0];

    if (context.length === 0) {
      logger.error("Error classifying mode", "context is empty");
      return fallbackLabel;
    }

    try {
      const llmMessages = context.map<Message>((entry) => {
        if (entry.role === "assistant") {
          return {
            role: "assistant",
            content: [{ type: "text", text: entry.content }],
            api: "",
            provider: "",
            model: "",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
          } satisfies AssistantMessage;
        }
        return {
          role: "user",
          content: entry.content,
          timestamp: Date.now(),
        } satisfies UserMessage;
      });

      const currentMessage = extractCurrentMessage(context[context.length - 1].content);
      const labels = Object.keys(commandConfig.modeClassifier.labels);
      const classifierPrompt =
        commandConfig.modeClassifier.prompt ??
        `Analyze the latest message and pick exactly one label: ${labels.join(", ")}. Message: {message}`;

      const prompt = classifierPrompt.replace("{message}", currentMessage);

      const response = await adapter.completeSimple(
        commandConfig.modeClassifier.model,
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

      // Try exact match first (the prompt asks for exactly one token).
      for (const label of labels) {
        if (normalizedText === label.toUpperCase()) {
          return label;
        }
      }

      // Fall back to whole-word boundary matching.
      let bestLabel = fallbackLabel;
      let bestCount = 0;
      for (const label of labels) {
        const pattern = new RegExp(`\\b${label.toUpperCase()}\\b`, "g");
        const count = (normalizedText.match(pattern) ?? []).length;
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
