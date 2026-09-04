import { type Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { AuthStore } from "../auth/auth-store.js";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";

import { extractStatus, extractThinking, isAssistantMessage, isTextContent, isToolCall, responseText } from "./message.js";
import { detectRefusalErrorSignal, detectRefusalSignal } from "./refusal-detection.js";
import { stringifyError } from "../utils/index.js";
import { PiAiModelAdapter } from "../models/pi-ai-model-adapter.js";
import { parseModelSpec } from "../models/model-spec.js";
import {
  createAgentSessionForInvocation,
  type RunnerLogger,
} from "./session-factory.js";
import { compactJson, safeJson, truncateForDebug } from "./debug-utils.js";
import type { ToolSet } from "./tools/types.js";
import type { SessionLimitsConfig } from "../config/muaddib-config.js";
import { currentCostSpan, recordUsage } from "../cost/cost-span.js";
import { LLM_CALL_TYPE, isLlmCallType } from "../cost/llm-call-type.js";

const DEFAULT_EMPTY_COMPLETION_RETRY_PROMPT =
  "<meta>No valid text or tool use found in response. Please try again.</meta>";

const ARTIFACT_TOOLS = new Set(["share_artifact", "generate_image"]);
const ARTIFACT_URL_PATTERN = /(?:Artifact shared|Generated image):\s+(https?:\/\/\S+)/g;

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
  authStorage: AuthStore;
  sessionLimits?: SessionLimitsConfig;
  emptyCompletionRetryPrompt?: string;
  /**
   * Unified response callback — fired for every non-empty assistant text
   * (including the final one), status messages (empty-completion retries),
   * and progress reports.  Fallback suffixes (refusal / vision) are appended
   * automatically once the respective fallback activates.
   */
  /**
   * Delivery callback for assistant text. `interim` marks progress chatter
   * (a turn that still calls tools, a <status> note, a retry notice) rather
   * than the actual answer, so buffering callers can drop it.
   */
  onResponse?: (text: string, meta: { interim: boolean }) => void | Promise<void>;
  llmDebugMaxChars?: number;
  metaReminder?: string;
  progressThresholdSeconds?: number;
  logger?: RunnerLogger;
  onAgentCreated?: (agent: Agent) => void;
  /**
   * When set, persist this prompt() invocation as a pi-coding-agent JSONL
   * session file at this exact path (typically
   * `<gondolin-session-host-dir>/.session-record.jsonl`, or another record
   * file in that directory for nested sessions sharing the same workspace).
   * Omit for an ephemeral in-memory session (used by subsessions without a
   * replayable workspace record, e.g. deepResearch).
   */
  sessionFile?: string;
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
  /** Path to the persisted session JSONL file, or `null` when in-memory. */
  sessionFile?: string | null;
  /** Short session identifier (from the session header). */
  sessionId?: string;
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
  private readonly onResponse?: (text: string, meta: { interim: boolean }) => void | Promise<void>;
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
    const toolSet = this.options.toolSet;
    let sessionCtx: Awaited<ReturnType<typeof createAgentSessionForInvocation>>;
    try {
      sessionCtx = await createAgentSessionForInvocation({
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
        sessionFile: this.options.sessionFile,
      });
    } catch (error) {
      // Session creation failed: no session to dispose, but the toolSet
      // (e.g. a Gondolin VM refcount) is ours to release.
      if (toolSet?.dispose) {
        try {
          await toolSet.dispose();
        } catch (cleanupError) {
          this.logger.warn(`toolSet cleanup after failed session creation threw: ${stringifyError(cleanupError)}`);
        }
      }
      throw error;
    }

    const { session, agent } = sessionCtx;

    // Wrap session.dispose immediately after creation (plain assignments, cannot
    // throw) so every later failure path has a single full-cleanup entrypoint.
    // It chains unsubscribe + toolSet.dispose() (e.g. Gondolin checkpoint)
    // before the original dispose; the inner try/finally guarantees the
    // AgentSession is disposed even when toolSet cleanup throws.  On the
    // success path this keeps the VM alive until the caller is done with the
    // session (e.g. for a memory-update prompt after the main response).
    const origDispose = typeof session.dispose === "function"
      ? session.dispose.bind(session)
      : undefined;
    let toolSetDisposed = false;
    let unsubscribed = false;
    let unsubscribe: (() => void) | undefined;
    session.dispose = async () => {
      if (!unsubscribed) {
        unsubscribed = true;
        unsubscribe?.();
      }
      try {
        if (!toolSetDisposed && toolSet?.dispose) {
          toolSetDisposed = true;
          await toolSet.dispose();
        }
      } finally {
        await origDispose?.();
      }
    };

    let sessionReturned = false;
    let usageRecorded = false;
    let promptAttempted = false;
    try {
      this.options.onAgentCreated?.(agent);
      let iterations = 0;
      let toolCallsCount = 0;

      // Mutable suffix appended to every onResponse call.  Updated by
      // promptWithRefusalFallback (refusal) and the tool_execution_end
      // handler (vision) so that all messages after a fallback carry the
      // annotation — not just the final response.
      let responseSuffix = "";
      let lastCreatedArtifactUrl: string | undefined;
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
      const queueResponseDelivery = (text: string, interim = false): void => {
        pendingResponseDelivery = pendingResponseDelivery
          .then(async () => {
            sessionCtx.responseTimestamp.lastResponseAt = Date.now();
            await this.onResponse?.(text, { interim });
          })
          .catch((error) => {
            if (pendingResponseError === null) {
              pendingResponseError = error;
            }
          });
      };

      let pendingArtifactUrlRetry: string | undefined;
      let artifactUrlRetryAttempted = false;
      const queueArtifactUrlRetryIfNeeded = (assistantMessage: unknown, text: string): boolean => {
        if (!lastCreatedArtifactUrl || artifactUrlRetryAttempted || pendingArtifactUrlRetry ||
            !isPotentialFinalAssistantMessage(assistantMessage) || text.includes(lastCreatedArtifactUrl)) {
          return false;
        }
        pendingArtifactUrlRetry = lastCreatedArtifactUrl;
        return true;
      };

      unsubscribe = session.subscribe((event) => {
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
            const { text, interim } = applyStatusPolicy(
              extractAssistantTextFromEvent(event.message).trim(),
              event.message,
              this.logger,
            );
            const assistantMessageObj = event.message && typeof event.message === "object"
              ? event.message as object
              : null;
            const queuedArtifactRetry = text && !responseMuted
              ? queueArtifactUrlRetryIfNeeded(event.message, text)
              : false;
            if (text && this.onResponse && !responseMuted) {
              if (!assistantMessageObj || !deliveredAssistantMessages.has(assistantMessageObj)) {
                if (queuedArtifactRetry) {
                  this.logger.debug("Deferring assistant response missing last artifact URL", `url=${pendingArtifactUrlRetry ?? "unknown"}`);
                } else {
                  if (assistantMessageObj) {
                    deliveredAssistantMessages.add(assistantMessageObj);
                  }
                  // Don't decorate NULL sentinel responses with suffixes — they must
                  // pass through to onResponse unchanged so callers can suppress them.
                  const decorated = responseSuffix && !/^["'`]?\s*null\s*["'`]?$/iu.test(text)
                    ? `${text} ${responseSuffix}`
                    : text;
                  queueResponseDelivery(decorated, interim);
                }
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

          if (!event.isError && ARTIFACT_TOOLS.has(event.toolName)) {
            lastCreatedArtifactUrl = extractCreatedArtifactUrl(event.result) ?? lastCreatedArtifactUrl;
          }

          // Vision fallback: once activated, annotate all subsequent responses.
          if (!event.isError && !responseSuffix.includes("vision fallback") &&
              sessionCtx.getVisionFallbackActivated() && options.visionFallbackModel) {
            const spec = parseModelSpec(options.visionFallbackModel);
            responseSuffix = `${responseSuffix} [vision fallback to ${spec.modelId}]`.trim();
          }
        }
      });

      // Provider-key preflight: inside the try so a missing key still runs the
      // finally cleanup instead of leaking the freshly created session.
      const primaryProvider = (await this.modelAdapter.resolve(this.model)).spec.provider;
      await sessionCtx.ensureProviderKey(primaryProvider);
      promptAttempted = true;

      const refusalFallbackActivated = await this.promptWithRefusalFallback(
        session,
        agent,
        prompt,
        options.refusalFallbackModel,
        sessionCtx.ensureProviderKey,
        (suffix) => { responseSuffix = `${responseSuffix} ${suffix}`.trim(); },
      );

      // Drain steers that raced with pi-agent-core's single post-turn_end poll.
      while (agent.hasQueuedMessages()) {
        await agent.continue();
      }

      const EMPTY_RETRY_DELAYS_MS = [5_000, 20_000, 60_000];
      // Treat "[internal monologue]" as empty — these are suppressed by
      // cleanResponseText in command-executor.ts, so the user would see nothing.
      let text = stripUndeliverableResponse(extractLastAssistantText(session.messages));
      for (let i = 0; i < EMPTY_RETRY_DELAYS_MS.length && !text; i += 1) {
        const emptyMsg = findLastAssistantMessage(session.messages);
        const reason = emptyMsg?.stopReason ?? "unknown";
        const errorDetail = emptyMsg?.errorMessage ? `: ${emptyMsg.errorMessage}` : "";
        // Hard billing failures (HTTP 402, e.g. OpenRouter "requires more
        // credits") won't resolve on retry — fail fast instead of burning
        // through the delays. Status is only matched at the start to avoid
        // false positives on numbers in message bodies.
        if (emptyMsg?.errorMessage && /^\s*(?:error\s*:?\s*)?402\b|requires more credits|insufficient credits|payment required/iu.test(emptyMsg.errorMessage)) {
          throw new Error(`Agent completion failed with non-retriable error: stopReason=${reason}${errorDetail}`);
        }
        const delaySec = EMPTY_RETRY_DELAYS_MS[i] / 1_000;
        const retryMsg = `Error: empty assistant text (stopReason=${reason}${errorDetail}), retrying in ${delaySec}s (${i + 1}/${EMPTY_RETRY_DELAYS_MS.length})`;
        this.logger.error(retryMsg);
        await this.onResponse?.(retryMsg, { interim: true });
        await new Promise((resolve) => setTimeout(resolve, EMPTY_RETRY_DELAYS_MS[i]));
        await session.prompt(this.emptyCompletionRetryPrompt);
        this.logLlmIo(`after_empty_retry_${i + 1}`, session.messages);
        text = stripUndeliverableResponse(extractLastAssistantText(session.messages));
      }

      if (!text) {
        throw new Error(`Agent produced empty completion after ${EMPTY_RETRY_DELAYS_MS.length} retries.`);
      }

      // The message_end hook queues this when it suppresses a response that
      // created an artifact but omitted the URL.  The fallback call covers rare
      // mocked/provider paths that append a final assistant message without a
      // message_end event.
      queueArtifactUrlRetryIfNeeded(findLastAssistantMessage(session.messages), text);
      if (pendingArtifactUrlRetry) {
        const url = pendingArtifactUrlRetry;
        pendingArtifactUrlRetry = undefined;
        artifactUrlRetryAttempted = true;
        this.logger.warn("Response missing last artifact URL, retrying", `url=${url}`);
        await session.prompt(buildArtifactUrlRetryPrompt(url));
        const retryText = stripUndeliverableResponse(extractLastAssistantText(session.messages));
        if (retryText) {
          text = retryText;
        }
      }

      const lastAssistant = findLastAssistantMessage(session.messages);
      // Recompute the status verdict for the missing-message_end fallback path,
      // so a status-only final message stays flagged interim here too.
      const finalInterim = lastAssistant
        ? applyStatusPolicy(responseText(lastAssistant), lastAssistant).interim
        : false;
      const finalResponseText = responseSuffix ? `${text} ${responseSuffix}` : text;
      const finalAlreadyDelivered =
        lastAssistant !== null && deliveredAssistantMessages.has(lastAssistant);

      if (this.onResponse && !responseMuted && !finalAlreadyDelivered) {
        if (lastAssistant) {
          deliveredAssistantMessages.add(lastAssistant);
        }
        queueResponseDelivery(finalResponseText, finalInterim);
      }

      await pendingResponseDelivery;
      if (pendingResponseError !== null) {
        throw pendingResponseError;
      }

      const usageSummary = sessionCtx.getUsageSummary();
      const callType = resolveCurrentLlmCallType();
      recordUsage(callType, this.model, usageSummary.usage);
      usageRecorded = true;

      sessionReturned = true;
      return {
        text,
        stopReason: lastAssistant?.stopReason ?? "stop",
        ...usageSummary,
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
        sessionFile: sessionCtx.sessionFile,
        sessionId: sessionCtx.sessionId,
        bumpSessionLimits: sessionCtx.bumpSessionLimits,
        muteResponses: () => {
          responseMuted = true;
        },
      };
    } finally {
      // Only account usage when the preflight passed — a failed key check made
      // no LLM calls.
      if (!usageRecorded && promptAttempted) {
        const usageSummary = sessionCtx.getUsageSummary();
        if (usageSummary.usage.totalTokens > 0 || usageSummary.usage.cost.total > 0) {
          recordUsage(resolveCurrentLlmCallType(), this.model, usageSummary.usage);
        }
      }
      // Error-path safety: if the session is never returned (exception before
      // return), run the full wrapped dispose (unsubscribe + toolSet.dispose +
      // AgentSession.dispose).  On the success path it is deferred — the
      // caller triggers it via session.dispose().  Cleanup failures are logged
      // rather than thrown so they cannot mask the primary error.
      if (!sessionReturned) {
        try {
          await session.dispose();
        } catch (cleanupError) {
          this.logger.warn(`Session cleanup after failed prompt() threw: ${stringifyError(cleanupError)}`);
        }
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

      // Anthropic refusals arrive as an empty message with stopReason "error"
      // and the refusal in errorMessage, not the body — probe both.
      const lastMessage = findLastAssistantMessage(session.messages);
      const bodyRefusal = detectRefusalSignal(extractLastAssistantText(session.messages));
      const errorRefusal =
        lastMessage?.stopReason === "error"
          ? detectRefusalErrorSignal(lastMessage.errorMessage ?? "")
          : null;
      if (!refusalFallbackModel || !(bodyRefusal ?? errorRefusal)) {
        return false;
      }
    } catch (error) {
      if (!refusalFallbackModel || !detectRefusalErrorSignal(stringifyError(error))) {
        throw error;
      }
    }

    const fallbackModel = await this.modelAdapter.resolve(refusalFallbackModel);
    await ensureProviderKey(fallbackModel.spec.provider);
    agent.state.model = fallbackModel.model;
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
  return assistant ? applyStatusPolicy(responseText(assistant), assistant).text : "";
}

/**
 * Responses that would be suppressed by cleanResponseText (command-executor.ts)
 * are treated as empty here so the retry loop re-prompts instead of returning
 * a response the user never sees.
 */
function stripUndeliverableResponse(text: string): string {
  if (text.startsWith("[internal monologue]")) return "";
  // A completion that is entirely an inline <thinking> block is stripped
  // before room delivery (command-executor's onResponse), so treat it as
  // empty here to trigger the retry loop instead of ending in silence.
  return extractThinking(text).text;
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

function buildArtifactUrlRetryPrompt(url: string): string {
  return `<meta>Your response must include the artifact URL you created so the user can access it. Missing URL: ${url}. Please respond again and include the URL in your answer.</meta>`;
}

function extractCreatedArtifactUrl(result: unknown): string | undefined {
  const text = textPayload(result);
  return [...text.matchAll(ARTIFACT_URL_PATTERN)].map((match) => match[1]).at(-1);
}

function textPayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter(isTextContent).map((block) => block.text).join("\n");
  if (value && typeof value === "object" && "content" in value) {
    return textPayload((value as { content: unknown }).content);
  }
  return "";
}

/**
 * Resolve `<status>` progress notes (requested by the progress nudge) against
 * the turn they arrived in: keep them while the model is still working (this
 * turn calls tools), drop them once it is answering, since a status line glued
 * in front of the answer reaches the room as a redundant restatement and eats
 * into the room's response length budget. A final message that is *only* a
 * status still gets delivered - silence would be worse.
 */
function applyStatusPolicy(
  text: string,
  message: unknown,
  logger?: RunnerLogger,
): { text: string; interim: boolean } {
  const stillWorking = !isPotentialFinalAssistantMessage(message);
  const { text: body, status, matched } = extractStatus(text);
  if (!matched) return { text, interim: stillWorking };
  if (stillWorking) {
    return { text: body ? `${status}\n\n${body}` : status, interim: true };
  }
  // "Status-only" is judged on *visible* body: extractStatus preserves leading
  // <thinking> blocks (they still have to reach monologue persistence), and
  // mistaking those for an answer would drop the status and leave a completion
  // that stripUndeliverableResponse() sees as empty - i.e. pointless retries.
  if (!extractThinking(body).text) {
    // Nothing but a status note: deliver it (silence would be worse) but flag
    // it as interim so quiet/proactive callers don't publish it as an answer.
    if (!status) return { text: body, interim: true };
    return { text: body ? `${body}\n${status}` : status, interim: true };
  }
  if (status) {
    logger?.debug("Dropping status note from final answer", truncateForDebug(status, 200));
  }
  return { text: body, interim: false };
}

function isPotentialFinalAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return true;
  const msg = message as AgentMessage;
  if (!isAssistantMessage(msg)) return false;
  const stopReason = String(msg.stopReason ?? "");
  if (stopReason === "tool_use" || stopReason === "toolUse") return false;
  return !msg.content.some((block) => isToolCall(block));
}

function resolveCurrentLlmCallType() {
  const spanName = currentCostSpan()?.name;
  return spanName && isLlmCallType(spanName)
    ? spanName
    : LLM_CALL_TYPE.AGENT_RUN;
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
