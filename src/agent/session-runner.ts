import { type Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentSession, AuthStorage } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, Message, Usage } from "@mariozechner/pi-ai";

import { isAssistantMessage, isTextContent, isToolCall, responseText } from "./message.js";
import { detectRefusalSignal } from "./refusal-detection.js";
import { stringifyError } from "../utils/index.js";
import { PiAiModelAdapter } from "../models/pi-ai-model-adapter.js";
import { parseModelSpec } from "../models/model-spec.js";
import {
  createAgentSessionForInvocation,
  type RunnerLogger,
} from "./session-factory.js";
import { compactJson, emptyUsage, safeJson, truncateForDebug } from "./debug-utils.js";
import type { ToolSet } from "./tools/types.js";
import type { SessionLimitsConfig } from "../config/muaddib-config.js";

const DEFAULT_EMPTY_COMPLETION_RETRY_PROMPT =
  "<meta>No valid text or tool use found in response. Please try again.</meta>";

export interface SessionRunnerOptions {
  model: string;
  systemPrompt: string;
  /**
   * Tools and their session-end cleanup.  SessionRunner extracts the tool list
   * for the agent and automatically calls toolSet.dispose() (if present) at the
   * end of every prompt() call — whether it succeeds or throws.
   */
  toolSet?: ToolSet;
  modelAdapter: PiAiModelAdapter;
  authStorage: AuthStorage;
  sessionLimits?: SessionLimitsConfig;
  emptyCompletionRetryPrompt?: string;
  /**
   * Unified response callback — fired for every non-empty assistant text
   * (including the final one), status messages (empty-completion retries),
   * and progress reports.  Fallback suffixes (refusal / vision) are appended
   * automatically once the respective fallback activates.
   */
  onResponse?: (text: string) => void | Promise<void>;
  llmDebugMaxChars?: number;
  metaReminder?: string;
  progressThresholdSeconds?: number;
  logger?: RunnerLogger;
  onAgentCreated?: (agent: Agent) => void;
}

export interface PromptOptions {
  contextMessages?: Message[];
  thinkingLevel?: ThinkingLevel;
  visionFallbackModel?: string;
  refusalFallbackModel?: string;
}

export interface PromptResult {
  text: string;
  stopReason: string;
  usage: Usage;
  /** Peak single-turn input tokens (input + cacheRead + cacheWrite) — represents actual context window fill. */
  peakTurnInput: number;
  iterations?: number;
  toolCallsCount?: number;
  visionFallbackActivated?: boolean;
  visionFallbackModel?: string;
  refusalFallbackActivated?: boolean;
  refusalFallbackModel?: string;
  session?: AgentSession;
  /** Increase the session's token/cost limits (e.g. before a follow-up prompt). */
  bumpSessionLimits?: (tokens: number, costUsd: number) => void;
  /** Stop firing onResponse for subsequent session.prompt() calls (e.g. memory update). */
  muteResponses?: () => void;
}

export class SessionRunner {
  private readonly model: string;
  private readonly tools: AgentTool<any>[];
  private readonly modelAdapter: PiAiModelAdapter;
  private readonly logger: RunnerLogger;
  private readonly emptyCompletionRetryPrompt: string;
  private readonly onResponse?: (text: string) => void | Promise<void>;
  private readonly llmDebugMaxChars: number;
  private readonly options: SessionRunnerOptions;

  constructor(options: SessionRunnerOptions) {
    this.options = options;
    this.model = options.model;
    this.tools = options.toolSet?.tools ?? [];
    this.modelAdapter = options.modelAdapter;
    this.logger = options.logger ?? console;
    this.emptyCompletionRetryPrompt =
      options.emptyCompletionRetryPrompt ?? DEFAULT_EMPTY_COMPLETION_RETRY_PROMPT;
    this.onResponse = options.onResponse;
    this.llmDebugMaxChars = Math.max(500, Math.floor(options.llmDebugMaxChars ?? 120_000));
  }

  async prompt(prompt: string, options: PromptOptions = {}): Promise<PromptResult> {
    const suffix = this.options.toolSet?.systemPromptSuffix;
    const systemPrompt = suffix
      ? `${this.options.systemPrompt}\n\n${suffix}`
      : this.options.systemPrompt;
    const sessionCtx = createAgentSessionForInvocation({
      model: this.model,
      systemPrompt,
      tools: this.tools,
      modelAdapter: this.modelAdapter,
      authStorage: this.options.authStorage,
      contextMessages: options.contextMessages,
      thinkingLevel: options.thinkingLevel,
      sessionLimits: this.options.sessionLimits,
      visionFallbackModel: options.visionFallbackModel,
      llmDebugMaxChars: this.llmDebugMaxChars,
      metaReminder: this.options.metaReminder,
      progressThresholdSeconds: this.options.progressThresholdSeconds,
      logger: this.logger,
    });

    const { session, agent } = sessionCtx;
    this.options.onAgentCreated?.(agent);
    const primaryProvider = this.modelAdapter.resolve(this.model).spec.provider;
    await sessionCtx.ensureProviderKey(primaryProvider);
    let iterations = 0;
    let toolCallsCount = 0;

    // Mutable suffix appended to every onResponse call.  Updated by
    // promptWithRefusalFallback (refusal) and the tool_execution_end
    // handler (vision) so that all messages after a fallback carry the
    // annotation — not just the final response.
    let responseSuffix = "";
    // When true, onResponse is skipped and text is logged at INFO instead.
    // Toggled by the muteResponses() handle returned in PromptResult so
    // callers can silence delivery before background work (memory update).
    let responseMuted = false;

    // Queue async onResponse deliveries and flush them before prompt() returns.
    // This guarantees callers don't observe "prompt completed" before room sends
    // and history persistence have finished.
    let pendingResponseDelivery: Promise<void> = Promise.resolve();
    let pendingResponseError: unknown = null;
    const deliveredAssistantMessages = new WeakSet<object>();
    const queueResponseDelivery = (text: string): void => {
      pendingResponseDelivery = pendingResponseDelivery
        .then(async () => {
          sessionCtx.responseTimestamp.lastResponseAt = Date.now();
          await this.onResponse?.(text);
        })
        .catch((error) => {
          if (pendingResponseError === null) {
            pendingResponseError = error;
          }
        });
    };

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
          const text = extractAssistantTextFromEvent(event.message).trim();
          const assistantMessageObj = event.message && typeof event.message === "object"
            ? event.message as object
            : null;
          if (text && this.onResponse && !responseMuted) {
            if (!assistantMessageObj || !deliveredAssistantMessages.has(assistantMessageObj)) {
              if (assistantMessageObj) {
                deliveredAssistantMessages.add(assistantMessageObj);
              }
              // Don't decorate NULL sentinel responses with suffixes — they must
              // pass through to onResponse unchanged so callers can suppress them.
              const decorated = responseSuffix && !/^["'`]?\s*null\s*["'`]?$/iu.test(text)
                ? `${text} ${responseSuffix}`
                : text;
              queueResponseDelivery(decorated);
            }
          } else if (text && responseMuted) {
            this.logger.info("Suppressing post-response text", truncateForDebug(text, 200));
          }

          this.logger.debug(
            "llm_io response agent_stream",
            safeJson(renderMessageForDebug(event.message, this.llmDebugMaxChars), this.llmDebugMaxChars),
          );
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

        // Vision fallback: once activated, annotate all subsequent responses.
        if (!event.isError && !responseSuffix.includes("vision fallback") &&
            sessionCtx.getVisionFallbackActivated() && options.visionFallbackModel) {
          const spec = parseModelSpec(options.visionFallbackModel);
          responseSuffix = `${responseSuffix} [vision fallback to ${spec.modelId}]`.trim();
        }
      }
    });

    // Wrap session.dispose so it chains toolSet.dispose() (e.g. Gondolin checkpoint)
    // before the original dispose.  This keeps the VM alive until the caller is done
    // with the session (e.g. for a memory-update prompt after the main response).
    const toolSet = this.options.toolSet;
    const origDispose = typeof session.dispose === "function"
      ? session.dispose.bind(session)
      : undefined;
    let toolSetDisposed = false;
    let unsubscribed = false;
    session.dispose = async () => {
      if (!unsubscribed) {
        unsubscribed = true;
        unsubscribe();
      }
      if (!toolSetDisposed && toolSet?.dispose) {
        toolSetDisposed = true;
        await toolSet.dispose();
      }
      await origDispose?.();
    };

    let sessionReturned = false;
    try {
      const refusalFallbackActivated = await this.promptWithRefusalFallback(
        session,
        agent,
        prompt,
        options.refusalFallbackModel,
        sessionCtx.ensureProviderKey,
        (suffix) => { responseSuffix = `${responseSuffix} ${suffix}`.trim(); },
      );

      const EMPTY_RETRY_DELAYS_MS = [5_000, 20_000, 60_000];
      let text = extractLastAssistantText(session.messages);
      for (let i = 0; i < EMPTY_RETRY_DELAYS_MS.length && !text; i += 1) {
        const emptyMsg = findLastAssistantMessage(session.messages);
        const reason = emptyMsg?.stopReason ?? "unknown";
        const errorDetail = emptyMsg?.errorMessage ? `: ${emptyMsg.errorMessage}` : "";
        const delaySec = EMPTY_RETRY_DELAYS_MS[i] / 1_000;
        const retryMsg = `Empty assistant text detected (stopReason=${reason}${errorDetail}), retrying in ${delaySec}s (${i + 1}/${EMPTY_RETRY_DELAYS_MS.length})`;
        this.logger.error(retryMsg);
        await this.onResponse?.(retryMsg);
        await new Promise((resolve) => setTimeout(resolve, EMPTY_RETRY_DELAYS_MS[i]));
        await session.prompt(this.emptyCompletionRetryPrompt);
        this.logLlmIo(`after_empty_retry_${i + 1}`, session.messages);
        text = extractLastAssistantText(session.messages);
      }

      if (!text) {
        throw new Error(`Agent produced empty completion after ${EMPTY_RETRY_DELAYS_MS.length} retries.`);
      }

      const lastAssistant = findLastAssistantMessage(session.messages);
      const finalResponseText = responseSuffix ? `${text} ${responseSuffix}` : text;
      const finalAlreadyDelivered =
        lastAssistant !== null && deliveredAssistantMessages.has(lastAssistant);

      if (this.onResponse && !responseMuted && !finalAlreadyDelivered) {
        if (lastAssistant) {
          deliveredAssistantMessages.add(lastAssistant);
        }
        queueResponseDelivery(finalResponseText);
      }

      await pendingResponseDelivery;
      if (pendingResponseError !== null) {
        throw pendingResponseError;
      }

      sessionReturned = true;
      return {
        text,
        stopReason: lastAssistant?.stopReason ?? "stop",
        ...sumAssistantUsage(session.messages),
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
        bumpSessionLimits: sessionCtx.bumpSessionLimits,
        muteResponses: () => {
          responseMuted = true;
        },
      };
    } finally {
      // Error-path safety: if the session is never returned (exception before return),
      // unsubscribe and ensure toolSet is still cleaned up.  On the success path,
      // both are deferred — the caller triggers them via session.dispose().
      if (!sessionReturned && !unsubscribed) {
        unsubscribed = true;
        unsubscribe();
      }
      if (!sessionReturned && !toolSetDisposed && toolSet?.dispose) {
        toolSetDisposed = true;
        await toolSet.dispose();
      }
    }
  }

  private logLlmIo(stage: string, messages: readonly AgentMessage[]): void {
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
    addSuffix: (suffix: string) => void,
  ): Promise<boolean> {
    try {
      await session.prompt(prompt);

      const text = extractLastAssistantText(session.messages);
      if (!refusalFallbackModel || !detectRefusalSignal(text)) {
        return false;
      }
    } catch (error) {
      if (!refusalFallbackModel || !detectRefusalSignal(stringifyError(error))) {
        throw error;
      }
    }

    const fallbackModel = this.modelAdapter.resolve(refusalFallbackModel);
    await ensureProviderKey(fallbackModel.spec.provider);
    agent.setModel(fallbackModel.model);
    addSuffix(`[refusal fallback to ${fallbackModel.spec.modelId}]`);
    await session.prompt(prompt);
    return true;
  }
}

/**
 * Return the text of the last non-aborted assistant message.
 * This is intentionally the *last* message — callers must see what the LLM
 * actually produced last, not an earlier message with "better" content.
 * Aborted turns (empty content from session.abort()) are the only exception.
 */
function extractLastAssistantText(messages: readonly AgentMessage[]): string {
  const assistant = findLastAssistantMessage(messages);
  return assistant ? responseText(assistant) : "";
}

function findLastAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (isAssistantMessage(msg) && msg.stopReason !== "aborted") {
      return msg;
    }
  }
  return null;
}


function sumAssistantUsage(messages: readonly AgentMessage[]): { usage: Usage; peakTurnInput: number } {
  const total = emptyUsage();
  let peakTurnInput = 0;

  for (const message of messages) {
    if (!isAssistantMessage(message)) {
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

    const turnInput = usage.input + usage.cacheRead + usage.cacheWrite;
    if (turnInput > peakTurnInput) {
      peakTurnInput = turnInput;
    }
  }

  return { usage: total, peakTurnInput };
}

function renderMessageForDebug(message: unknown, maxChars: number): Record<string, unknown> {
  if (!message || typeof message !== "object") {
    return { value: truncateForDebug(String(message), maxChars) };
  }

  const record = message as Record<string, unknown>;
  const rendered: Record<string, unknown> = {
    ...record,
    role: typeof record.role === "string" ? record.role : "unknown",
  };

  if ("content" in record) {
    rendered.content = renderContentForDebug(record.content, maxChars);
  }

  return rendered;
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

    const block = entry as { type: string } & Record<string, unknown>;

    if (isTextContent(block)) {
      return {
        ...block,
        text: truncateForDebug(block.text, maxChars),
      };
    }

    if (block.type === "thinking") {
      return {
        ...block,
        thinking: truncateForDebug(String(block.thinking ?? ""), maxChars),
      };
    }

    if (block.type === "image") {
      const data = typeof block.data === "string" ? block.data : "";
      const { data: _data, ...rest } = block;
      return {
        ...rest,
        dataLength: data.length,
        dataPreview: truncateForDebug(data, Math.min(120, maxChars)),
      };
    }

    if (block.type === "image_url" && block.image_url && typeof block.image_url === "object") {
      const inner = block.image_url as Record<string, unknown>;
      if (typeof inner.url === "string" && inner.url.startsWith("data:")) {
        return {
          type: "image_url",
          image_url: { url: truncateForDebug(inner.url, Math.min(120, maxChars)) },
        };
      }
    }

    if (isToolCall(block)) {
      return {
        ...block,
      };
    }

    return block;
  });
}

/** Extract text from a single assistant message event payload. */
function extractAssistantTextFromEvent(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as AgentMessage;
  if (!isAssistantMessage(msg)) return "";
  return responseText(msg);
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
