import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@mariozechner/pi-ai";

import { PiAiModelAdapter, type ResolvedPiAiModel } from "../models/pi-ai-model-adapter.js";

export interface MuaddibAgentRunnerOptions {
  model: string;
  systemPrompt: string;
  tools?: AgentTool<any>[];
  modelAdapter?: PiAiModelAdapter;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

export type RunnerContextMessage =
  | {
      role: Extract<Message["role"], "user" | "assistant">;
      content: string;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: string;
      isError?: boolean;
    };

export interface SingleTurnResult {
  assistantMessage: AssistantMessage;
  text: string;
  stopReason: AssistantMessage["stopReason"];
  usage: Usage;
}

export interface SingleTurnOptions {
  contextMessages?: RunnerContextMessage[];
  images?: ImageContent[];
  thinkingLevel?: ThinkingLevel;
}

/**
 * Thin wrapper around pi-agent-core used as the replacement foundation
 * for muaddib's previous custom actor loop.
 */
export class MuaddibAgentRunner {
  private readonly modelInfo: ResolvedPiAiModel;
  private readonly agent: Agent;

  constructor(options: MuaddibAgentRunnerOptions) {
    const modelAdapter = options.modelAdapter ?? new PiAiModelAdapter();
    this.modelInfo = modelAdapter.resolve(options.model);

    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: this.modelInfo.model,
        thinkingLevel: "off",
        tools: options.tools ?? [],
      },
      getApiKey: options.getApiKey,
    });
  }

  get modelSpec(): string {
    return `${this.modelInfo.spec.provider}:${this.modelInfo.spec.modelId}`;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    return this.agent.subscribe(listener);
  }

  registerTool(tool: AgentTool<any>): void {
    this.agent.setTools([...this.agent.state.tools, tool]);
  }

  registerTools(tools: AgentTool<any>[]): void {
    this.agent.setTools([...this.agent.state.tools, ...tools]);
  }

  getRegisteredTools(): AgentTool<any>[] {
    return [...this.agent.state.tools];
  }

  abort(): void {
    this.agent.abort();
  }

  async runSingleTurn(prompt: string, options: SingleTurnOptions = {}): Promise<SingleTurnResult> {
    this.agent.setThinkingLevel(options.thinkingLevel ?? "off");

    if (options.contextMessages) {
      this.agent.replaceMessages(
        convertContextToAgentMessages(options.contextMessages, this.modelInfo.spec.provider, this.modelInfo.model.api, this.modelInfo.spec.modelId),
      );
    }

    await this.agent.prompt(prompt, options.images ?? []);

    const assistantMessage = this.findLastAssistantMessage();
    if (!assistantMessage) {
      throw new Error("No assistant response produced by agent.");
    }

    return {
      assistantMessage,
      text: extractText(assistantMessage),
      stopReason: assistantMessage.stopReason,
      usage: assistantMessage.usage,
    };
  }

  private findLastAssistantMessage(): AssistantMessage | null {
    for (let i = this.agent.state.messages.length - 1; i >= 0; i -= 1) {
      const message = this.agent.state.messages[i];
      if (message.role === "assistant") {
        return message as AssistantMessage;
      }
    }
    return null;
  }
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
}

function convertContextToAgentMessages(
  contextMessages: RunnerContextMessage[],
  provider: string,
  api: string,
  modelId: string,
): AgentMessage[] {
  const now = Date.now();

  return contextMessages.map((message, index): AgentMessage => {
    const timestamp = now + index;

    if (message.role === "toolResult") {
      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: [{ type: "text", text: message.content }],
        details: {},
        isError: Boolean(message.isError),
        timestamp,
      };
      return toolResult;
    }

    if (message.role === "assistant") {
      const assistant: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        api,
        provider,
        model: modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp,
      };
      return assistant;
    }

    const user: UserMessage = {
      role: "user",
      content: [{ type: "text", text: message.content }],
      timestamp,
    };
    return user;
  });
}
