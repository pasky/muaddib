import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  Message,
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

export interface RunnerContextMessage {
  role: Extract<Message["role"], "user" | "assistant">;
  content: string;
}

export interface SingleTurnResult {
  assistantMessage: AssistantMessage;
  text: string;
  stopReason: AssistantMessage["stopReason"];
  usage: Usage;
}

export interface SingleTurnOptions {
  contextMessages?: RunnerContextMessage[];
  images?: ImageContent[];
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
    if (options.contextMessages) {
      this.agent.replaceMessages(convertContextToAgentMessages(options.contextMessages));
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

function convertContextToAgentMessages(contextMessages: RunnerContextMessage[]): AgentMessage[] {
  const now = Date.now();
  return contextMessages.map((message, index): UserMessage => ({
    // For milestone 4 context replay, keep context as user-visible text blocks.
    // Full assistant/tool replay fidelity will be expanded in later milestones.
    role: "user",
    content: [
      {
        type: "text",
        text: message.role === "assistant" ? `[assistant] ${message.content}` : message.content,
      },
    ],
    timestamp: now + index,
  }));
}
