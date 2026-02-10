import {
  completeSimple,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type UserMessage,
} from "@mariozechner/pi-ai";

import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import type { CommandConfig } from "./resolver.js";

type CompleteSimpleFn = (
  model: Model<any>,
  context: { messages: UserMessage[]; systemPrompt?: string },
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface ModeClassifierOptions {
  modelAdapter?: PiAiModelAdapter;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  completeFn?: CompleteSimpleFn;
}

export function createModeClassifier(
  commandConfig: CommandConfig,
  options: ModeClassifierOptions = {},
): (context: Array<{ role: string; content: string }>) => Promise<string> {
  const adapter = options.modelAdapter ?? new PiAiModelAdapter();

  const completeFn = options.completeFn ?? completeSimple;

  return async (context: Array<{ role: string; content: string }>): Promise<string> => {
    const fallbackLabel =
      commandConfig.mode_classifier.fallback_label ??
      Object.keys(commandConfig.mode_classifier.labels)[0];

    if (context.length === 0) {
      return fallbackLabel;
    }

    try {
      const classifierModel = adapter.resolve(commandConfig.mode_classifier.model).model;
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

      const response = await completeFn(
        classifierModel,
        {
          messages: llmMessages,
          systemPrompt:
            "Return exactly one classifier label token. No explanation. If uncertain, pick the best label.",
        },
        {
          apiKey: options.getApiKey ? await options.getApiKey(classifierModel.provider) : undefined,
          maxTokens: 16,
        },
      );

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ")
        .trim()
        .toUpperCase();

      const counts = new Map<string, number>();
      for (const label of labels) {
        counts.set(label, countOccurrences(text, label.toUpperCase()));
      }

      let bestLabel = fallbackLabel;
      let bestCount = 0;
      for (const [label, count] of counts.entries()) {
        if (count > bestCount) {
          bestLabel = label;
          bestCount = count;
        }
      }

      return bestCount === 0 ? fallbackLabel : bestLabel;
    } catch {
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
