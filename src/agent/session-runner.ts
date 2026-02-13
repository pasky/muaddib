import type { Agent, AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";

import { PiAiModelAdapter } from "../models/pi-ai-model-adapter.js";
import {
  createAgentSessionForInvocation,
  type RunnerLogger,
  type SessionFactoryContextMessage,
} from "./session-factory.js";

const DEFAULT_EMPTY_COMPLETION_RETRY_PROMPT =
  "<meta>No valid text or tool use found in response. Please try again.</meta>";

export interface SessionRunnerOptions {
  model: string;
  systemPrompt: string;
  tools?: AgentTool<any>[];
  modelAdapter?: PiAiModelAdapter;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  maxIterations?: number;
  emptyCompletionRetryPrompt?: string;
  logger?: RunnerLogger;
}

export interface SingleTurnOptions {
  contextMessages?: SessionFactoryContextMessage[];
  thinkingLevel?: ThinkingLevel;
  visionFallbackModel?: string;
  refusalFallbackModel?: string;
  persistenceSummaryModel?: string;
  onPersistenceSummary?: (text: string) => void | Promise<void>;
}

export interface SingleTurnResult {
  text: string;
  stopReason: string;
  usage: Usage;
  iterations?: number;
  toolCallsCount?: number;
  visionFallbackActivated?: boolean;
  visionFallbackModel?: string;
  session?: AgentSession;
}

export class SessionRunner {
  private readonly model: string;
  private readonly systemPrompt: string;
  private readonly tools: AgentTool<any>[];
  private readonly modelAdapter: PiAiModelAdapter;
  private readonly getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  private readonly maxIterations?: number;
  private readonly logger: RunnerLogger;
  private readonly emptyCompletionRetryPrompt: string;

  constructor(options: SessionRunnerOptions) {
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.tools = options.tools ?? [];
    this.modelAdapter = options.modelAdapter ?? new PiAiModelAdapter();
    this.getApiKey = options.getApiKey;
    this.maxIterations = options.maxIterations;
    this.logger = options.logger ?? console;
    this.emptyCompletionRetryPrompt =
      options.emptyCompletionRetryPrompt ?? DEFAULT_EMPTY_COMPLETION_RETRY_PROMPT;
  }

  async runSingleTurn(prompt: string, options: SingleTurnOptions = {}): Promise<SingleTurnResult> {
    const sessionCtx = createAgentSessionForInvocation({
      model: this.model,
      systemPrompt: this.systemPrompt,
      tools: this.tools,
      modelAdapter: this.modelAdapter,
      getApiKey: this.getApiKey,
      contextMessages: options.contextMessages,
      thinkingLevel: options.thinkingLevel,
      maxIterations: this.maxIterations,
      visionFallbackModel: options.visionFallbackModel,
      logger: this.logger,
    });

    const { session, agent } = sessionCtx;
    let iterations = 0;
    let toolCallsCount = 0;

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_end") {
        iterations += 1;
        return;
      }

      if (event.type === "tool_execution_start") {
        toolCallsCount += 1;
        this.logger.info(`Tool ${event.toolName} started`);
        return;
      }

      if (event.type === "tool_execution_end") {
        if (event.isError) {
          this.logger.warn(`Tool ${event.toolName} failed`);
        } else {
          this.logger.info(`Tool ${event.toolName} executed`);
        }
      }
    });

    try {
      await this.promptWithRefusalFallback(session, agent, prompt, options.refusalFallbackModel);

      let text = extractLastAssistantText(session.messages);
      for (let i = 0; i < 3 && !text; i += 1) {
        await session.prompt(this.emptyCompletionRetryPrompt);
        text = extractLastAssistantText(session.messages);
      }

      if (!text) {
        throw new Error("Agent produced empty completion.");
      }

      const lastAssistant = findLastAssistantMessage(session.messages);
      return {
        text,
        stopReason: lastAssistant?.stopReason ?? "stop",
        usage: sumAssistantUsage(session.messages),
        iterations,
        toolCallsCount,
        visionFallbackActivated: sessionCtx.getVisionFallbackActivated(),
        visionFallbackModel: sessionCtx.getVisionFallbackActivated()
          ? options.visionFallbackModel
          : undefined,
        session,
      };
    } finally {
      unsubscribe();
    }
  }

  private async promptWithRefusalFallback(
    session: AgentSession,
    agent: Agent,
    prompt: string,
    refusalFallbackModel?: string,
  ): Promise<void> {
    try {
      await session.prompt(prompt);
    } catch (error) {
      if (!refusalFallbackModel || !detectRefusalFallbackSignal(stringifyError(error))) {
        throw error;
      }

      const fallbackModel = this.modelAdapter.resolve(refusalFallbackModel);
      agent.setModel(fallbackModel.model);
      await session.prompt(prompt);
      return;
    }

    const text = extractLastAssistantText(session.messages);
    if (!refusalFallbackModel || !detectRefusalFallbackSignal(text)) {
      return;
    }

    const fallbackModel = this.modelAdapter.resolve(refusalFallbackModel);
    agent.setModel(fallbackModel.model);
    await session.prompt(prompt);
  }
}

const REFUSAL_FALLBACK_SIGNAL_PATTERNS: ReadonlyArray<RegExp> = [
  /["']is_refusal["']\s*:\s*true/iu,
  /the ai refused to respond to this request/iu,
  /invalid_prompt[\s\S]{0,160}safety reasons/iu,
  /content safety refusal/iu,
];

function detectRefusalFallbackSignal(text: string): boolean {
  const candidate = text.trim();
  return candidate.length > 0 && REFUSAL_FALLBACK_SIGNAL_PATTERNS.some((pattern) => pattern.test(candidate));
}

function extractLastAssistantText(messages: readonly unknown[]): string {
  const assistant = findLastAssistantMessage(messages);
  if (!assistant) {
    return "";
  }

  return assistant.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function findLastAssistantMessage(messages: readonly unknown[]): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string };
    if (message.role === "assistant") {
      return messages[i] as AssistantMessage;
    }
  }
  return null;
}

function sumAssistantUsage(messages: readonly unknown[]): Usage {
  const total = emptyUsage();

  for (const message of messages as AssistantMessage[]) {
    if (message.role !== "assistant") {
      continue;
    }

    const usage = message.usage;
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

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
