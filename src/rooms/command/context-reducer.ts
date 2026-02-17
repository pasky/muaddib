import type { Message } from "@mariozechner/pi-ai";
import { createStubAssistantFields } from "../../history/chat-history-store.js";
import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import type { Logger } from "../../app/logging.js";

export interface ContextReducerConfig {
  model?: string;
  prompt?: string;
}

export interface ContextReducer {
  readonly isConfigured: boolean;
  reduce(
    context: Message[],
    agentSystemPrompt: string,
  ): Promise<Message[]>;
}

export interface ContextReducerTsOptions {
  config?: ContextReducerConfig;
  modelAdapter: PiAiModelAdapter;
  logger?: Logger;
}

export class ContextReducerTs implements ContextReducer {
  private readonly config: ContextReducerConfig;
  private readonly modelAdapter: PiAiModelAdapter;
  private readonly logger?: Logger;
  constructor(options: ContextReducerTsOptions) {
    this.config = options.config ?? {};
    this.modelAdapter = options.modelAdapter;
    this.logger = options.logger;
  }

  get isConfigured(): boolean {
    return Boolean(this.config.model && this.config.prompt);
  }

  async reduce(
    context: Message[],
    agentSystemPrompt: string,
  ): Promise<Message[]> {
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
          logger: this.logger,
          streamOptions: { maxTokens: 2_048, reasoning: "low" },
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
    } catch (error) {
      this.logger?.error?.("Context reduction failed, returning unreduced context", error);
      return contextToReduce;
    }
  }

  private formatContextForReduction(
    context: Message[],
    agentSystemPrompt: string,
  ): string {
    const lines: string[] = [];

    lines.push("## AGENT SYSTEM PROMPT (for context)");
    lines.push(agentSystemPrompt);

    lines.push("");
    lines.push("## CONVERSATION HISTORY TO CONDENSE");

    for (const message of context.slice(0, -1)) {
      const role = message.role === "assistant" ? "ASSISTANT" : "USER";
      const text = message.role === "assistant"
        ? message.content.filter((b) => b.type === "text").map((b) => b.text).join(" ")
        : typeof message.content === "string" ? message.content : message.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
      lines.push(`[${role}]: ${text}`);
    }

    lines.push("");
    lines.push("## TRIGGERING INPUT (for relevance - do not include in output)");
    const last = context[context.length - 1];
    const lastText = last
      ? (last.role === "assistant"
          ? last.content.filter((b) => b.type === "text").map((b) => b.text).join(" ")
          : typeof last.content === "string" ? last.content : last.content.filter((b) => b.type === "text").map((b) => b.text).join(" "))
      : "";
    lines.push(lastText);

    return lines.join("\n");
  }

  private parseReducedContext(response: string): Message[] {
    const messages: Message[] = [];
    const pattern = /\[(USER|ASSISTANT)\]:[ ]*(.*?)(?=\n\[(?:USER|ASSISTANT)\]:|$)/gis;

    for (const match of response.matchAll(pattern)) {
      const role = match[1]?.toLowerCase();
      const content = match[2]?.trim() ?? "";
      if (!content) {
        continue;
      }

      if (role === "assistant") {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: content }],
          ...createStubAssistantFields(),
          timestamp: 0,
        });
      } else {
        messages.push({
          role: "user",
          content,
          timestamp: 0,
        });
      }
    }

    if (messages.length > 0) {
      return messages;
    }

    return [
      {
        role: "user",
        content: `<context_summary>${response.trim()}</context_summary>`,
        timestamp: 0,
      },
    ];
  }
}
