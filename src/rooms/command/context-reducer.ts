import type { ChatRole } from "../../history/chat-history-store.js";
import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";

export interface ContextReducerConfig {
  model?: string;
  prompt?: string;
}

export interface ContextReducer {
  readonly isConfigured: boolean;
  reduce(
    context: Array<{ role: ChatRole; content: string }>,
    agentSystemPrompt: string,
  ): Promise<Array<{ role: ChatRole; content: string }>>;
}

interface ContextReducerLogger {
  debug(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
}

export interface ContextReducerTsOptions {
  config?: ContextReducerConfig;
  modelAdapter: PiAiModelAdapter;
  logger?: ContextReducerLogger;
}

export class ContextReducerTs implements ContextReducer {
  private readonly config: ContextReducerConfig;
  private readonly modelAdapter: PiAiModelAdapter;
  constructor(private readonly options: ContextReducerTsOptions) {
    this.config = options.config ?? {};
    this.modelAdapter = options.modelAdapter;
  }

  get isConfigured(): boolean {
    return Boolean(this.config.model && this.config.prompt);
  }

  async reduce(
    context: Array<{ role: ChatRole; content: string }>,
    agentSystemPrompt: string,
  ): Promise<Array<{ role: ChatRole; content: string }>> {
    const contextToReduce = context.slice(0, -1);

    if (!this.isConfigured) {
      return contextToReduce;
    }

    if (contextToReduce.length === 0) {
      return [];
    }

    const reducerModelSpec = this.config.model ?? "";
    const formattedContext = this.formatContextForReduction(context, agentSystemPrompt);

    try {
      const response = await this.modelAdapter.completeSimple(
        reducerModelSpec,
        {
          messages: [
            {
              role: "user",
              content: formattedContext,
              timestamp: Date.now(),
            },
          ],
          systemPrompt: this.config.prompt,
        },
        {
          callType: "context_reducer",
          logger: this.options.logger,
          streamOptions: { maxTokens: 2_048 },
        },
      );

      const reducedText = response.content
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text)
        .join("\n")
        .trim();

      if (!reducedText) {
        return contextToReduce;
      }

      return this.parseReducedContext(reducedText);
    } catch {
      return contextToReduce;
    }
  }

  private formatContextForReduction(
    context: Array<{ role: ChatRole; content: string }>,
    agentSystemPrompt: string,
  ): string {
    const lines: string[] = [];

    lines.push("## AGENT SYSTEM PROMPT (for context)");
    lines.push(agentSystemPrompt);

    lines.push("");
    lines.push("## CONVERSATION HISTORY TO CONDENSE");

    for (const message of context.slice(0, -1)) {
      const role = message.role === "assistant" ? "ASSISTANT" : "USER";
      lines.push(`[${role}]: ${message.content}`);
    }

    lines.push("");
    lines.push("## TRIGGERING INPUT (for relevance - do not include in output)");
    lines.push(context[context.length - 1]?.content ?? "");

    return lines.join("\n");
  }

  private parseReducedContext(response: string): Array<{ role: ChatRole; content: string }> {
    const messages: Array<{ role: ChatRole; content: string }> = [];
    const pattern = /\[(USER|ASSISTANT)\]:[ ]*(.*?)(?=\n\[(?:USER|ASSISTANT)\]:|$)/gis;

    for (const match of response.matchAll(pattern)) {
      const role = match[1]?.toLowerCase();
      const content = match[2]?.trim() ?? "";
      if (!content) {
        continue;
      }

      messages.push({
        role: role === "assistant" ? "assistant" : "user",
        content,
      });
    }

    if (messages.length > 0) {
      return messages;
    }

    return [
      {
        role: "user",
        content: `<context_summary>${response.trim()}</context_summary>`,
      },
    ];
  }
}
