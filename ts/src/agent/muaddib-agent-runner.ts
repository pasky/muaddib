import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
  type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type ToolResultMessage,
  type Usage,
  type UserMessage,
} from "@mariozechner/pi-ai";

import { PiAiModelAdapter, type ResolvedPiAiModel } from "../models/pi-ai-model-adapter.js";

const DEFAULT_MAX_ITERATIONS = 15;
const DEFAULT_MAX_COMPLETION_RETRIES = 1;
const DEFAULT_EMPTY_COMPLETION_RETRY_PROMPT =
  "<meta>Your previous completion was empty. Provide a non-empty final response now.</meta>";
const ITERATION_LIMIT_ERROR_PREFIX = "agent_iteration_limit:";

export interface MuaddibAgentRunnerOptions {
  model: string;
  systemPrompt: string;
  tools?: AgentTool<any>[];
  modelAdapter?: PiAiModelAdapter;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  streamFn?: StreamFn;
  maxIterations?: number;
  maxCompletionRetries?: number;
  emptyCompletionRetryPrompt?: string;
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
  iterations?: number;
  completionAttempts?: number;
}

export interface SingleTurnOptions {
  contextMessages?: RunnerContextMessage[];
  images?: ImageContent[];
  thinkingLevel?: ThinkingLevel;
  maxIterations?: number;
  maxCompletionRetries?: number;
  emptyCompletionRetryPrompt?: string;
}

export class AgentIterationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentIterationLimitError";
  }
}

/**
 * Wrapper around pi-agent-core with muaddib command-path behavior:
 * - multi-step tool loop via Agent,
 * - iteration cap,
 * - non-empty completion retries,
 * - final_answer tool-result fallback extraction.
 */
export class MuaddibAgentRunner {
  private readonly modelInfo: ResolvedPiAiModel;
  private readonly agent: Agent;
  private readonly maxIterations: number;
  private readonly maxCompletionRetries: number;
  private readonly emptyCompletionRetryPrompt: string;

  constructor(options: MuaddibAgentRunnerOptions) {
    const modelAdapter = options.modelAdapter ?? new PiAiModelAdapter();
    this.modelInfo = modelAdapter.resolve(options.model);

    this.maxIterations = normalizePositiveInteger(options.maxIterations, DEFAULT_MAX_ITERATIONS);
    this.maxCompletionRetries = normalizeNonNegativeInteger(
      options.maxCompletionRetries,
      DEFAULT_MAX_COMPLETION_RETRIES,
    );
    this.emptyCompletionRetryPrompt =
      options.emptyCompletionRetryPrompt ?? DEFAULT_EMPTY_COMPLETION_RETRY_PROMPT;

    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: this.modelInfo.model,
        thinkingLevel: "off",
        tools: options.tools ?? [],
      },
      getApiKey: options.getApiKey,
      streamFn: options.streamFn,
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
        convertContextToAgentMessages(
          options.contextMessages,
          this.modelInfo.spec.provider,
          this.modelInfo.model.api,
          this.modelInfo.spec.modelId,
        ),
      );
    }

    const runStartIndex = this.agent.state.messages.length;
    const maxIterations = normalizePositiveInteger(options.maxIterations, this.maxIterations);
    const maxCompletionRetries = normalizeNonNegativeInteger(
      options.maxCompletionRetries,
      this.maxCompletionRetries,
    );
    const emptyCompletionRetryPrompt =
      options.emptyCompletionRetryPrompt ?? this.emptyCompletionRetryPrompt;

    const previousStreamFn = this.agent.streamFn;
    let iterationCount = 0;
    this.agent.streamFn = async (...args) => {
      iterationCount += 1;
      if (iterationCount > maxIterations) {
        return createIterationLimitErrorStream(this.modelInfo, maxIterations);
      }
      return await previousStreamFn(...args);
    };

    let completionAttempt = 0;

    try {
      while (true) {
        const promptText = completionAttempt === 0 ? prompt : emptyCompletionRetryPrompt;
        const images = completionAttempt === 0 ? (options.images ?? []) : [];

        await this.agent.prompt(promptText, images);
        this.throwIfAgentFailed();

        const runMessages = this.agent.state.messages.slice(runStartIndex);
        const assistantMessage = findLastAssistantMessage(runMessages);
        if (!assistantMessage) {
          throw new Error("No assistant response produced by agent.");
        }

        const completionText = extractCompletionText(runMessages);
        if (completionText) {
          return {
            assistantMessage,
            text: completionText,
            stopReason: assistantMessage.stopReason,
            usage: sumAssistantUsage(runMessages),
            iterations: iterationCount,
            completionAttempts: completionAttempt + 1,
          };
        }

        if (completionAttempt >= maxCompletionRetries) {
          throw new Error(
            `Agent produced empty completion after ${completionAttempt + 1} attempt(s).`,
          );
        }

        completionAttempt += 1;
      }
    } finally {
      this.agent.streamFn = previousStreamFn;
    }
  }

  private throwIfAgentFailed(): void {
    const error = this.agent.state.error?.trim();
    if (!error) {
      return;
    }

    if (error.startsWith(ITERATION_LIMIT_ERROR_PREFIX)) {
      const limit = Number(error.slice(ITERATION_LIMIT_ERROR_PREFIX.length));
      const limitText = Number.isFinite(limit) ? String(limit) : "configured";
      throw new AgentIterationLimitError(`Agent exceeded max iterations (${limitText}).`);
    }

    throw new Error(`Agent run failed: ${error}`);
  }
}

function createIterationLimitErrorStream(
  modelInfo: ResolvedPiAiModel,
  maxIterations: number,
) {
  const stream = createAssistantMessageEventStream();
  const errorMessage = `${ITERATION_LIMIT_ERROR_PREFIX}${maxIterations}`;

  const assistantError: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: modelInfo.model.api,
    provider: modelInfo.spec.provider,
    model: modelInfo.spec.modelId,
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };

  queueMicrotask(() => {
    stream.push({
      type: "error",
      reason: "error",
      error: assistantError,
    });
  });

  return stream;
}

function findLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "assistant") {
      return message as AssistantMessage;
    }
  }
  return null;
}

function extractCompletionText(messages: AgentMessage[]): string {
  const assistantText = findLastNonEmptyAssistantText(messages);
  if (assistantText) {
    return assistantText;
  }

  const finalAnswerText = findLastFinalAnswerToolResultText(messages);
  if (finalAnswerText) {
    return finalAnswerText;
  }

  return "";
}

function findLastNonEmptyAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") {
      continue;
    }

    const text = (message as AssistantMessage).content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();

    if (text) {
      return text;
    }
  }

  return "";
}

function findLastFinalAnswerToolResultText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "toolResult") {
      continue;
    }

    const toolResult = message as ToolResultMessage;
    if (toolResult.toolName !== "final_answer" || toolResult.isError) {
      continue;
    }

    const text = toolResult.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();

    if (!text) {
      continue;
    }

    const cleaned = stripThinkingTags(text);
    if (cleaned && cleaned !== "...") {
      return cleaned;
    }
  }

  return "";
}

function stripThinkingTags(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ").trim();
}

function sumAssistantUsage(messages: AgentMessage[]): Usage {
  const total = emptyUsage();

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    const usage = (message as AssistantMessage).usage;
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.totalTokens += usage.totalTokens;
    total.cost.input += usage.cost.input;
    total.cost.output += usage.cost.output;
    total.cost.cacheRead += usage.cost.cacheRead;
    total.cost.cacheWrite += usage.cost.cacheWrite;
    total.cost.total += usage.cost.total;
  }

  return total;
}

function emptyUsage(): Usage {
  return {
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
  };
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
        usage: emptyUsage(),
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

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}
