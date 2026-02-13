import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
  type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import {
  completeSimple,
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
const PERSISTENCE_SUMMARY_SYSTEM_PROMPT =
  "As an AI agent, you need to remember in the future what tools you used when generating a response, and what the tools told you. Summarize all tool uses in a single concise paragraph. If artifact links are included, include every artifact link and tie each link to the corresponding tool call.";

type ToolPersistType = "summary" | "artifact";

const TOOL_PERSISTENCE_POLICY: Readonly<Record<string, ToolPersistType | "none">> = {
  web_search: "summary",
  visit_webpage: "summary",
  execute_code: "artifact",
  progress_report: "none",
  final_answer: "none",
  make_plan: "none",
  share_artifact: "none",
  edit_artifact: "artifact",
  generate_image: "artifact",
  oracle: "none",
  chronicle_read: "summary",
  chronicle_append: "summary",
  quest_start: "summary",
  subquest_start: "summary",
  quest_snooze: "summary",
};

const FINAL_ANSWER_QUEST_TOOLS = new Set(["quest_start", "subquest_start", "quest_snooze"]);
const FINAL_ANSWER_ALLOWED_WITH = new Set([
  "final_answer",
  "progress_report",
  "make_plan",
  ...FINAL_ANSWER_QUEST_TOOLS,
]);

interface PersistentToolCall {
  toolName: string;
  input: unknown;
  output: unknown;
  persistType: ToolPersistType;
  artifactUrls: string[];
}

interface FinalAnswerEvaluation {
  accepted: boolean;
  text: string;
  assistantMessage: AssistantMessage;
  toolNamesInTurn: string[];
  rejectionReason?: string;
}

interface RunnerLogger {
  debug(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
}

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
  completeSimpleFn?: typeof completeSimple;
  logger?: RunnerLogger;
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
  toolCallsCount?: number;
}

export interface SingleTurnOptions {
  contextMessages?: RunnerContextMessage[];
  images?: ImageContent[];
  thinkingLevel?: ThinkingLevel;
  maxIterations?: number;
  maxCompletionRetries?: number;
  emptyCompletionRetryPrompt?: string;
  persistenceSummaryModel?: string;
  onPersistenceSummary?: (text: string) => void | Promise<void>;
  visionFallbackModel?: string;
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
  private readonly modelAdapter: PiAiModelAdapter;
  private readonly getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  private readonly completeSimpleFn: typeof completeSimple;
  private readonly logger: RunnerLogger;

  constructor(options: MuaddibAgentRunnerOptions) {
    this.modelAdapter = options.modelAdapter ?? new PiAiModelAdapter();
    this.modelInfo = this.modelAdapter.resolve(options.model);
    this.getApiKey = options.getApiKey;
    this.completeSimpleFn = options.completeSimpleFn ?? completeSimple;
    this.logger = options.logger ?? console;

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
      getApiKey: this.getApiKey,
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

    const visionFallbackModel = resolveVisionFallbackModel(
      this.modelAdapter,
      options.visionFallbackModel,
      this.modelInfo.spec.provider,
      this.modelInfo.spec.modelId,
    );

    let visionFallbackInUse = false;
    let visionFallbackActivated = false;
    const previousStreamFn = this.agent.streamFn;
    let iterationCount = 0;
    this.agent.streamFn = async (...args: Parameters<StreamFn>) => {
      iterationCount += 1;
      if (iterationCount > 1) {
        this.logger.info(`Agent iteration ${iterationCount}/${maxIterations}`);
      }
      if (iterationCount > maxIterations) {
        this.logger.warn("Exceeding max iterations...");
        return createIterationLimitErrorStream(this.modelInfo, maxIterations);
      }

      if (visionFallbackInUse && visionFallbackModel) {
        const overriddenArgs = [visionFallbackModel.model, ...args.slice(1)] as Parameters<StreamFn>;
        return await previousStreamFn(...overriddenArgs);
      }

      return await previousStreamFn(...args);
    };

    const persistentToolCalls: PersistentToolCall[] = [];
    const toolArgsByCallId = new Map<string, unknown>();
    let toolCallsCount = 0;
    const turnState: { latestAcceptedFinalAnswer: FinalAnswerEvaluation | null } = {
      latestAcceptedFinalAnswer: null,
    };

    const unsubscribe = this.agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        toolCallsCount += 1;
        toolArgsByCallId.set(event.toolCallId, event.args);
        return;
      }

      if (event.type === "tool_execution_end") {
        const input = toolArgsByCallId.get(event.toolCallId);
        toolArgsByCallId.delete(event.toolCallId);

        if (event.isError) {
          this.logger.warn(`Tool ${event.toolName} failed: ${formatToolResultPreviewForInfo(event.result)}`);
          this.logger.debug(
            `Tool ${event.toolName} error details: ${renderToolResultDetailsForLog(event.result)}`,
          );
          return;
        }

        this.logger.info(`Tool ${event.toolName} executed: ${formatToolResultPreviewForInfo(event.result)}`);
        this.logger.debug(
          `Tool ${event.toolName} result details: ${renderToolResultDetailsForLog(event.result)}`,
        );

        if (!visionFallbackInUse && visionFallbackModel && hasImageToolOutput(event.result)) {
          visionFallbackInUse = true;
          visionFallbackActivated = true;
        }

        const persistType = getToolPersistType(event.toolName);
        if (!persistType) {
          return;
        }

        persistentToolCalls.push({
          toolName: event.toolName,
          input,
          output: event.result,
          persistType,
          artifactUrls: extractArtifactUrls(event.result),
        });
        return;
      }

      if (event.type !== "turn_end" || event.message.role !== "assistant") {
        return;
      }

      const finalAnswerEvaluation = evaluateFinalAnswerToolResultForTurn(
        event.message as AssistantMessage,
        event.toolResults,
      );
      if (!finalAnswerEvaluation) {
        return;
      }

      if (!finalAnswerEvaluation.accepted) {
        this.logger.warn(
          "Rejecting final_answer as terminal response",
          `reason=${finalAnswerEvaluation.rejectionReason ?? "invalid_final_answer_turn"}`,
          `tools=${finalAnswerEvaluation.toolNamesInTurn.join(",")}`,
        );
        return;
      }

      turnState.latestAcceptedFinalAnswer = finalAnswerEvaluation;
    });

    let completionAttempt = 0;

    try {
      while (true) {
        const promptText = completionAttempt === 0 ? prompt : emptyCompletionRetryPrompt;
        const images = completionAttempt === 0 ? (options.images ?? []) : [];

        resetLatestAcceptedFinalAnswer(turnState);
        await this.agent.prompt(promptText, images);

        const runMessages = this.agent.state.messages.slice(runStartIndex);
        const assistantMessage = findLastAssistantMessage(runMessages);
        if (!assistantMessage) {
          throw new Error("No assistant response produced by agent.");
        }

        const acceptedFinalAnswer: FinalAnswerEvaluation | null = turnState.latestAcceptedFinalAnswer;
        const agentError = this.agent.state.error?.trim();
        if (agentError) {
          if (acceptedFinalAnswer) {
            this.logger.warn(
              "Agent run ended with stream error after accepted final_answer; returning final_answer result.",
              `error=${agentError}`,
            );

            const finalText =
              visionFallbackActivated && visionFallbackModel
                ? `${acceptedFinalAnswer.text} [image fallback to ${modelSlug(visionFallbackModel.spec.modelId)}]`
                : acceptedFinalAnswer.text;

            return {
              assistantMessage: acceptedFinalAnswer.assistantMessage,
              text: finalText,
              stopReason: acceptedFinalAnswer.assistantMessage.stopReason,
              usage: sumAssistantUsage(runMessages),
              iterations: iterationCount,
              completionAttempts: completionAttempt + 1,
              toolCallsCount,
            };
          }

          this.throwIfAgentFailed();
        }

        const assistantCompletionText = findLastNonEmptyAssistantText(runMessages);
        const completionText = assistantCompletionText || (acceptedFinalAnswer?.text ?? "");

        if (completionText) {
          const responseAssistantMessage =
            assistantCompletionText
              ? assistantMessage
              : (acceptedFinalAnswer?.assistantMessage ?? assistantMessage);

          const finalText =
            visionFallbackActivated && visionFallbackModel
              ? `${completionText} [image fallback to ${modelSlug(visionFallbackModel.spec.modelId)}]`
              : completionText;

          return {
            assistantMessage: responseAssistantMessage,
            text: finalText,
            stopReason: responseAssistantMessage.stopReason,
            usage: sumAssistantUsage(runMessages),
            iterations: iterationCount,
            completionAttempts: completionAttempt + 1,
            toolCallsCount,
          };
        }

        if (completionAttempt >= maxCompletionRetries) {
          throw new Error(
            `Agent produced empty completion after ${completionAttempt + 1} attempt(s).`,
          );
        }

        completionAttempt += 1;
        this.logger.warn(`Empty completion from agent, retrying (${completionAttempt}/${maxCompletionRetries})...`);
      }
    } catch (error) {
      this.logger.error("Agent iteration failed:", stringifyError(error));
      throw error;
    } finally {
      unsubscribe();
      this.agent.streamFn = previousStreamFn;
      await this.generateAndEmitPersistenceSummary(persistentToolCalls, options);
    }
  }

  private async generateAndEmitPersistenceSummary(
    persistentToolCalls: PersistentToolCall[],
    options: SingleTurnOptions,
  ): Promise<void> {
    if (
      !options.onPersistenceSummary ||
      !options.persistenceSummaryModel ||
      persistentToolCalls.length === 0
    ) {
      return;
    }

    try {
      const summaryModel = this.modelAdapter.resolve(options.persistenceSummaryModel);
      const summaryResponse = await this.completeSimpleFn(
        summaryModel.model,
        {
          systemPrompt: PERSISTENCE_SUMMARY_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildPersistenceSummaryInput(persistentToolCalls),
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: await this.resolveApiKey(summaryModel.spec.provider),
        },
      );

      const summaryText = summaryResponse.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      if (summaryText) {
        await options.onPersistenceSummary(summaryText);
      }
    } catch (error) {
      this.logger.error("Failed to generate tool persistence summary:", stringifyError(error));
    }
  }

  private async resolveApiKey(provider: string): Promise<string | undefined> {
    if (!this.getApiKey) {
      return undefined;
    }

    const value = await this.getApiKey(provider);
    if (typeof value !== "string") {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
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

function evaluateFinalAnswerToolResultForTurn(
  assistantMessage: AssistantMessage,
  toolResults: ToolResultMessage[],
): FinalAnswerEvaluation | null {
  const finalAnswerToolResult = [...toolResults]
    .reverse()
    .find((toolResult) => toolResult.toolName === "final_answer" && !toolResult.isError);
  if (!finalAnswerToolResult) {
    return null;
  }

  const text = finalAnswerToolResult.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
  const cleaned = stripThinkingTags(text);
  if (!cleaned || cleaned === "...") {
    return null;
  }

  const toolNamesInTurn = Array.from(
    new Set(
      assistantMessage.content
        .filter((content) => content.type === "toolCall")
        .map((toolCall) => toolCall.name),
    ),
  );

  const disallowedTools = toolNamesInTurn.filter((toolName) => !FINAL_ANSWER_ALLOWED_WITH.has(toolName));
  if (disallowedTools.length > 0) {
    return {
      accepted: false,
      text: cleaned,
      assistantMessage,
      toolNamesInTurn,
      rejectionReason: "disallowed_tool_combo",
    };
  }

  const hasQuestTool = toolNamesInTurn.some((toolName) => FINAL_ANSWER_QUEST_TOOLS.has(toolName));
  const hasMakePlan = toolNamesInTurn.includes("make_plan");
  if (hasMakePlan && !hasQuestTool) {
    return {
      accepted: false,
      text: cleaned,
      assistantMessage,
      toolNamesInTurn,
      rejectionReason: "make_plan_without_quest_tool",
    };
  }

  return {
    accepted: true,
    text: cleaned,
    assistantMessage,
    toolNamesInTurn,
  };
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

function getToolPersistType(toolName: string): ToolPersistType | null {
  const policy = TOOL_PERSISTENCE_POLICY[toolName];
  if (policy === "summary" || policy === "artifact") {
    return policy;
  }
  return null;
}

function buildPersistenceSummaryInput(persistentToolCalls: PersistentToolCall[]): string {
  const lines: string[] = [
    "The following tool calls were made during this conversation:",
  ];

  for (const call of persistentToolCalls) {
    lines.push(`\n\n# Calling tool **${call.toolName}** (persist: ${call.persistType})`);
    lines.push(`## **Input:**\n${renderPersistenceValue(call.input)}\n`);
    lines.push(`## **Output:**\n${renderPersistenceValue(call.output)}\n`);

    for (const artifactUrl of call.artifactUrls) {
      lines.push(`(Tool call I/O stored as artifact: ${artifactUrl})\n`);
    }
  }

  lines.push("\nPlease provide a concise summary of what was accomplished in these tool calls.");
  return lines.join("\n");
}

function renderPersistenceValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const sanitized = sanitizePersistenceValue(value);
  if (typeof sanitized === "string") {
    return sanitized;
  }

  try {
    return JSON.stringify(sanitized, null, 2);
  } catch {
    return String(sanitized);
  }
}

function sanitizePersistenceValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizePersistenceValue(item));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    if (record.type === "image") {
      const mimeType =
        typeof record.mimeType === "string"
          ? record.mimeType
          : typeof (record.source as Record<string, unknown> | undefined)?.media_type === "string"
            ? String((record.source as Record<string, unknown>).media_type)
            : "image";
      return `[image: ${mimeType}]`;
    }

    const output: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(record)) {
      if (key === "data" && typeof entryValue === "string" && entryValue.length > 128) {
        output[key] = `${entryValue.slice(0, 64)}...`;
        continue;
      }
      output[key] = sanitizePersistenceValue(entryValue);
    }
    return output;
  }

  return String(value);
}

function resolveVisionFallbackModel(
  modelAdapter: PiAiModelAdapter,
  visionFallbackModel: string | undefined,
  primaryProvider: string,
  primaryModelId: string,
): ResolvedPiAiModel | null {
  const candidate = visionFallbackModel?.trim();
  if (!candidate) {
    return null;
  }

  const resolved = modelAdapter.resolve(candidate);
  if (resolved.spec.provider === primaryProvider && resolved.spec.modelId === primaryModelId) {
    return null;
  }

  return resolved;
}

function hasImageToolOutput(value: unknown): boolean {
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) {
      continue;
    }

    if (typeof current !== "object") {
      continue;
    }

    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      for (const entry of current) {
        stack.push(entry);
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    if (record.type === "image" || record.kind === "image") {
      return true;
    }

    for (const entry of Object.values(record)) {
      stack.push(entry);
    }
  }

  return false;
}

function modelSlug(modelId: string): string {
  return modelId.replace(/(?:.*\/)?([^#/]+)(?:#.*)?/u, "$1");
}

function extractArtifactUrls(result: unknown): string[] {
  const urls = new Set<string>();

  if (!result || typeof result !== "object") {
    return [];
  }

  const record = result as Record<string, unknown>;
  const details = record.details;
  if (details && typeof details === "object") {
    const artifactUrls = (details as Record<string, unknown>).artifactUrls;
    if (Array.isArray(artifactUrls)) {
      for (const artifactUrl of artifactUrls) {
        if (typeof artifactUrl === "string" && artifactUrl.trim().length > 0) {
          urls.add(artifactUrl.trim());
        }
      }
    }
  }

  const content = record.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const block = entry as Record<string, unknown>;
      if (block.type !== "text") {
        continue;
      }

      const text = block.text;
      if (typeof text !== "string") {
        continue;
      }

      for (const url of extractUrlsFromText(text)) {
        urls.add(url);
      }
    }
  }

  return Array.from(urls);
}

function extractUrlsFromText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)]+/giu);
  if (!matches) {
    return [];
  }

  return matches.map((entry) => entry.replace(/[.,;:!?]+$/u, ""));
}

function summarizeToolResultForLog(result: unknown): string {
  if (Array.isArray(result)) {
    return summarizeToolBlocksForLog(result);
  }

  if (!result || typeof result !== "object") {
    return String(result).slice(0, 100);
  }

  const record = result as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    return summarizeToolBlocksForLog(content);
  }

  return renderPersistenceValue(result).slice(0, 100);
}

function summarizeToolBlocksForLog(content: unknown[]): string {
  const logBlocks: string[] = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type === "image") {
      const source = (block.source as Record<string, unknown> | undefined) ?? {};
      const mediaType =
        typeof block.mimeType === "string"
          ? block.mimeType
          : typeof source.media_type === "string"
            ? source.media_type
            : "image";
      const data =
        typeof block.data === "string"
          ? block.data
          : typeof source.data === "string"
            ? source.data
            : "";
      const truncated = data.length > 64 ? `${data.slice(0, 64)}...` : data;
      logBlocks.push(`[image: ${mediaType}, ${truncated}]`);
      continue;
    }

    if (block.type === "text") {
      logBlocks.push(String(block.text ?? "").slice(0, 100));
      continue;
    }

    logBlocks.push(renderPersistenceValue(block).slice(0, 100));
  }

  if (logBlocks.length === 0) {
    return "";
  }

  return logBlocks.join(", ");
}

function formatToolResultPreviewForInfo(result: unknown): string {
  const preview = summarizeToolResultForLog(result).trim();
  return `${preview || "<empty>"}...`;
}

function renderToolResultDetailsForLog(result: unknown): string {
  return renderPersistenceValue(result);
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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

function resetLatestAcceptedFinalAnswer(state: { latestAcceptedFinalAnswer: FinalAnswerEvaluation | null }): void {
  state.latestAcceptedFinalAnswer = null;
}
