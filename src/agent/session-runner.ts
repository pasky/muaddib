import { type Agent, type AgentTool, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentSession, AuthStorage } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, Message, Usage } from "@mariozechner/pi-ai";

import { detectRefusalSignal } from "./refusal-detection.js";
import { stringifyError } from "../utils/index.js";
import { PiAiModelAdapter } from "../models/pi-ai-model-adapter.js";
import {
  createAgentSessionForInvocation,
  type RunnerLogger,
} from "./session-factory.js";
import { compactJson, emptyUsage, safeJson, truncateForDebug } from "./debug-utils.js";

const DEFAULT_EMPTY_COMPLETION_RETRY_PROMPT =
  "<meta>No valid text or tool use found in response. Please try again.</meta>";

export interface SessionRunnerOptions {
  model: string;
  systemPrompt: string;
  tools?: AgentTool<any>[];
  modelAdapter: PiAiModelAdapter;
  authStorage: AuthStorage;
  maxIterations?: number;
  emptyCompletionRetryPrompt?: string;
  llmDebugMaxChars?: number;
  metaReminder?: string;
  progressThresholdSeconds?: number;
  progressMinIntervalSeconds?: number;
  logger?: RunnerLogger;
  onAgentCreated?: (agent: Agent) => void;
}

export interface PromptOptions {
  contextMessages?: Message[];
  thinkingLevel?: ThinkingLevel;
  visionFallbackModel?: string;
  refusalFallbackModel?: string;
  persistenceSummaryModel?: string;
  onPersistenceSummary?: (text: string) => void | Promise<void>;
}

export interface PromptResult {
  text: string;
  stopReason: string;
  usage: Usage;
  iterations?: number;
  toolCallsCount?: number;
  visionFallbackActivated?: boolean;
  visionFallbackModel?: string;
  refusalFallbackActivated?: boolean;
  refusalFallbackModel?: string;
  session?: AgentSession;
}

export class SessionRunner {
  private readonly model: string;
  private readonly tools: AgentTool<any>[];
  private readonly modelAdapter: PiAiModelAdapter;
  private readonly logger: RunnerLogger;
  private readonly emptyCompletionRetryPrompt: string;
  private readonly llmDebugMaxChars: number;
  private readonly options: SessionRunnerOptions;

  constructor(options: SessionRunnerOptions) {
    this.options = options;
    this.model = options.model;
    this.tools = options.tools ?? [];
    this.modelAdapter = options.modelAdapter;
    this.logger = options.logger ?? console;
    this.emptyCompletionRetryPrompt =
      options.emptyCompletionRetryPrompt ?? DEFAULT_EMPTY_COMPLETION_RETRY_PROMPT;
    this.llmDebugMaxChars = Math.max(500, Math.floor(options.llmDebugMaxChars ?? 120_000));
  }

  async prompt(prompt: string, options: PromptOptions = {}): Promise<PromptResult> {
    const sessionCtx = createAgentSessionForInvocation({
      model: this.model,
      systemPrompt: this.options.systemPrompt,
      tools: this.tools,
      modelAdapter: this.modelAdapter,
      authStorage: this.options.authStorage,
      contextMessages: options.contextMessages,
      thinkingLevel: options.thinkingLevel,
      maxIterations: this.options.maxIterations,
      visionFallbackModel: options.visionFallbackModel,
      llmDebugMaxChars: this.llmDebugMaxChars,
      metaReminder: this.options.metaReminder,
      progressThresholdSeconds: this.options.progressThresholdSeconds,
      progressMinIntervalSeconds: this.options.progressMinIntervalSeconds,
      logger: this.logger,
    });

    const { session, agent } = sessionCtx;
    this.options.onAgentCreated?.(agent);
    const primaryProvider = this.modelAdapter.resolve(this.model).spec.provider;
    await sessionCtx.ensureProviderKey(primaryProvider);
    let iterations = 0;
    let toolCallsCount = 0;

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_end") {
        iterations += 1;
        return;
      }

      if (event.type === "tool_execution_start") {
        toolCallsCount += 1;
        this.logger.info(`Tool ${event.toolName} started: ${summarizeToolPayload(event.args, this.llmDebugMaxChars)}`);
        return;
      }

      if (event.type === "message_end") {
        const message = event.message as { role?: string };
        if (message.role === "assistant") {
          this.logger.debug("llm_io response agent_stream", safeJson(renderMessageForDebug(event.message, this.llmDebugMaxChars), this.llmDebugMaxChars));
        }
        return;
      }

      if (event.type === "tool_execution_end") {
        if (event.isError) {
          this.logger.warn(`Tool ${event.toolName} failed: ${summarizeToolPayload(event.result, this.llmDebugMaxChars)}`);
        } else {
          this.logger.info(`Tool ${event.toolName} executed: ${summarizeToolPayload(event.result, this.llmDebugMaxChars)}`);
        }
        this.logger.debug(
          "tool_execution_end details",
          safeJson({
            toolName: event.toolName,
            isError: event.isError,
            result: event.result,
          }, this.llmDebugMaxChars),
        );
      }
    });

    try {
      const refusalFallbackActivated = await this.promptWithRefusalFallback(
        session,
        agent,
        prompt,
        options.refusalFallbackModel,
        sessionCtx.ensureProviderKey,
      );

      let text = extractLastAssistantText(session.messages);
      for (let i = 0; i < 3 && !text; i += 1) {
        this.logger.debug(`Empty assistant text detected, retrying completion (${i + 1}/3)`);
        await session.prompt(this.emptyCompletionRetryPrompt);
        this.logLlmIo(`after_empty_retry_${i + 1}`, session.messages);
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
        refusalFallbackActivated,
        refusalFallbackModel: refusalFallbackActivated
          ? options.refusalFallbackModel
          : undefined,
        session,
      };
    } finally {
      unsubscribe();
    }
  }

  private logLlmIo(stage: string, messages: readonly unknown[]): void {
    const rendered = messages.map((message) => renderMessageForDebug(message, this.llmDebugMaxChars));
    this.logger.debug(`llm_io ${stage}`, safeJson(rendered, this.llmDebugMaxChars));
  }

  /**
   * Prompt the session, retrying with a fallback model if a refusal is detected.
   * Returns true if the fallback model was activated.
   */
  private async promptWithRefusalFallback(
    session: AgentSession,
    agent: Agent,
    prompt: string,
    refusalFallbackModel: string | undefined,
    ensureProviderKey: (provider: string) => Promise<void>,
  ): Promise<boolean> {
    try {
      await session.prompt(prompt);
    } catch (error) {
      if (!refusalFallbackModel || !detectRefusalSignal(stringifyError(error))) {
        throw error;
      }

      const fallbackModel = this.modelAdapter.resolve(refusalFallbackModel);
      await ensureProviderKey(fallbackModel.spec.provider);
      agent.setModel(fallbackModel.model);
      await session.prompt(prompt);
      return true;
    }

    const text = extractLastAssistantText(session.messages);
    if (!refusalFallbackModel || !detectRefusalSignal(text)) {
      return false;
    }

    const fallbackModel = this.modelAdapter.resolve(refusalFallbackModel);
    await ensureProviderKey(fallbackModel.spec.provider);
    agent.setModel(fallbackModel.model);
    await session.prompt(prompt);
    return true;
  }
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

function renderMessageForDebug(message: unknown, maxChars: number): Record<string, unknown> {
  if (!message || typeof message !== "object") {
    return { value: truncateForDebug(String(message), maxChars) };
  }

  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : "unknown";

  return {
    role,
    timestamp: record.timestamp,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    isError: record.isError,
    content: renderContentForDebug(record.content, maxChars),
    stopReason: record.stopReason,
    provider: record.provider,
    model: record.model,
  };
}

function renderContentForDebug(content: unknown, maxChars: number): unknown {
  if (typeof content === "string") {
    return truncateForDebug(content, maxChars);
  }

  if (!Array.isArray(content)) {
    return content;
  }

  return content.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }

    const block = entry as Record<string, unknown>;
    const type = block.type;

    if (type === "text") {
      return {
        type,
        text: truncateForDebug(String(block.text ?? ""), maxChars),
      };
    }

    if (type === "thinking") {
      return {
        type,
        thinking: truncateForDebug(String(block.thinking ?? ""), maxChars),
      };
    }

    if (type === "image") {
      const data = typeof block.data === "string" ? block.data : "";
      return {
        type,
        mimeType: block.mimeType,
        dataLength: data.length,
        dataPreview: truncateForDebug(data, Math.min(120, maxChars)),
      };
    }

    if (type === "toolCall") {
      return {
        type,
        id: block.id,
        name: block.name,
        arguments: block.arguments,
      };
    }

    return block;
  });
}

function summarizeToolPayload(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    return truncateForDebug(value.replaceAll("\n", " "), maxChars);
  }

  // For objects with a "content" key, summarize only that key
  if (value && typeof value === "object" && !Array.isArray(value) && "content" in value) {
    return summarizeToolPayload((value as Record<string, unknown>).content, maxChars);
  }

  return compactJson(value, maxChars);
}
