import { Agent, type AgentMessage, type AgentTool, type StreamFn, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { streamSimple, type Message } from "@mariozechner/pi-ai";
import { isAssistantMessage } from "./message.js";
import {
  AgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  convertToLlm,
  createExtensionRuntime,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";


import { PiAiModelAdapter, type ResolvedPiAiModel } from "../models/pi-ai-model-adapter.js";
import type { Logger } from "../app/logging.js";
import { safeJson } from "./debug-utils.js";
import type { SessionLimitsConfig } from "../config/muaddib-config.js";

const DEFAULT_MAX_CONTEXT_LENGTH = 100_000;
const DEFAULT_MAX_COST_USD = 1.0;

// ── Internal nudge transform ──

/**
 * Build a function that decides what nudge text (if any) to inject for a given
 * assistant turn count. Encapsulates all policy: metaReminder, progress threshold,
 * high-reasoning first-turn special case, and near-limit suppression.
 */
/** Mutable session-limit state shared between turn_end subscriber and nudge logic. */
interface SessionLimitState {
  maxContextLength: number;
  maxCostUsd: number;
  /** Peak context length (input + cacheRead + cacheWrite) seen in any single turn. */
  peakContextLength: number;
  cumulativeCost: number;
  turnsSinceSoftLimit: number;
}

/** Mutable timestamp holder — bumped externally when a response is delivered. */
export interface ResponseTimestamp {
  lastResponseAt: number;
}

function createNudgeDecider(
  limitState: SessionLimitState,
  sessionStartTime: number,
  thinkingLevel: NonNullable<CreateAgentSessionInput["thinkingLevel"]>,
  responseTimestamp: ResponseTimestamp,
  metaReminder?: string,
  progressThresholdSeconds?: number,
): (turnCount: number) => string | null {
  return (turnCount: number): string | null => {
    const parts: string[] = [];

    if (metaReminder) {
      parts.push(metaReminder);
    }

    // Suppress progress nudges when within 80% of either limit.
    const nearLimit =
      limitState.peakContextLength >= limitState.maxContextLength * 0.8 ||
      limitState.cumulativeCost >= limitState.maxCostUsd * 0.8;

    if (progressThresholdSeconds != null && !nearLimit) {
      const now = Date.now();
      const lastActivity = Math.max(sessionStartTime, responseTimestamp.lastResponseAt);
      const elapsedSinceLastReport = (now - lastActivity) / 1000;
      const isFirstTurnHighReasoning =
        turnCount === 1 && (thinkingLevel === "medium" || thinkingLevel === "high" || thinkingLevel === "xhigh");

      if (isFirstTurnHighReasoning || elapsedSinceLastReport >= progressThresholdSeconds) {
        parts.push("If you are going to call more tools, write also an extremely brief one-line status of what you are doing and why.");
      }
    }

    return parts.length > 0 ? parts.join(" ") : null;
  };
}

/**
 * Build a transformContext function that injects internal <meta> nudges
 * (and session-limit messages) ephemerally into the LLM context just before
 * each assistant call.  The injected message is visible to the LLM but never
 * persisted into agent.state.messages, so it cannot trigger extra turns.
 */
function createInternalNudgeTransform(
  invocationStartMessageCount: number,
  limitState: SessionLimitState,
  getNudgeText: (turnCount: number) => string | null,
  logger: Logger,
) {

  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    // Count assistant turns produced in this invocation (not from preloaded context).
    const invocationMessages = messages.slice(invocationStartMessageCount);
    const turnCount = invocationMessages.filter(isAssistantMessage).length;

    const limitReached =
      limitState.peakContextLength >= limitState.maxContextLength ||
      limitState.cumulativeCost >= limitState.maxCostUsd;

    // When session limit is reached, inject the limit message instead of
    // regular nudges.
    if (limitReached) {
      const lastMsg = invocationMessages.at(-1) as { role?: string } | undefined;
      const lastIsToolResult = lastMsg?.role === "toolResult";
      if (!lastIsToolResult) return messages;

      logger.debug("session_limit_nudge_injected via transformContext");
      return [
        ...messages,
        {
          role: "user",
          content: [{ type: "text", text: "<meta>You have reached your session limit - time to provide your final text response.</meta>" }],
          timestamp: Date.now(),
        } as AgentMessage,
      ];
    }

    const isFirstTurn = turnCount === 0;
    const lastMsg = invocationMessages.at(-1) as { role?: string; stopReason?: string } | undefined;
    const lastIsToolResult = lastMsg?.role === "toolResult";
    // The most recent assistant message (immediately before the toolResult block)
    const lastAssistant = [...invocationMessages].reverse().find(isAssistantMessage);
    const lastStopReason = lastAssistant?.stopReason;
    const isAfterToolUse = lastIsToolResult && lastStopReason === "toolUse";

    if (!isFirstTurn && !isAfterToolUse) {
      return messages;
    }

    const nudgeContent = getNudgeText(turnCount);
    if (nudgeContent === null) {
      return messages;
    }

    const nudgeText = `<meta>${nudgeContent}</meta>`;
    logger.debug(
      `internal_nudge_injected turnCount=${turnCount} isFirstTurn=${isFirstTurn} lastStopReason=${lastStopReason}`,
    );

    return [
      ...messages,
      {
        role: "user",
        content: [{ type: "text", text: nudgeText }],
        timestamp: Date.now(),
      } as AgentMessage,
    ];
  };
}

const EMPTY_RESOURCE_LOADER_BASE: Omit<ResourceLoader, "getExtensions" | "getSystemPrompt"> = {
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getAppendSystemPrompt: () => [],
  getPathMetadata: () => new Map(),
  extendResources: () => {},
  reload: async () => {},
};

export type RunnerLogger = Logger;

interface CreateAgentSessionInput {
  model: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  authStorage: AuthStorage;
  modelAdapter: PiAiModelAdapter;
  contextMessages?: Message[];
  thinkingLevel?: ThinkingLevel;
  sessionLimits?: SessionLimitsConfig;
  visionFallbackModel?: string;
  llmDebugMaxChars?: number;
  metaReminder?: string;
  progressThresholdSeconds?: number;
  logger?: Logger;
}

interface CreateAgentSessionResult {
  session: AgentSession;
  agent: Agent;
  responseTimestamp: ResponseTimestamp;
  ensureProviderKey: (provider: string) => Promise<void>;
  getVisionFallbackActivated: () => boolean;
  bumpSessionLimits: (tokens: number, costUsd: number) => void;
  dispose: () => void;
}

export function createAgentSessionForInvocation(input: CreateAgentSessionInput): CreateAgentSessionResult {
  const logger = input.logger ?? console;
  const resolvedModel = input.modelAdapter.resolve(input.model);
  const sessionManager = SessionManager.inMemory();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });

  const resourceLoader: ResourceLoader = {
    ...EMPTY_RESOURCE_LOADER_BASE,
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSystemPrompt: () => input.systemPrompt,
  };

  const modelRegistry = new ModelRegistry(input.authStorage);
  const llmDebugMaxChars = Math.max(500, Math.floor(input.llmDebugMaxChars ?? 120_000));

  // Mutable vision-fallback state: when activated, the streamFn will override
  // the model parameter to use the vision-capable model. This bypasses the
  // stale `config.model` that pi-agent-core's _runLoop captures by value at
  // loop start, avoiding a wasted turn + 5s delay on non-vision models.
  const visionState = { activated: false, model: null as ResolvedPiAiModel["model"] | null };
  const streamFn = createTracingStreamFn(logger, llmDebugMaxChars, visionState);

  // Compute session limits, session start, and nudge state before Agent construction
  // so they can be captured in the transformContext closure.
  const limitState: SessionLimitState = {
    maxContextLength: input.sessionLimits?.maxContextLength ?? DEFAULT_MAX_CONTEXT_LENGTH,
    maxCostUsd: input.sessionLimits?.maxCostUsd ?? DEFAULT_MAX_COST_USD,
    peakContextLength: 0,
    cumulativeCost: 0,
    turnsSinceSoftLimit: 0,
  };
  const initialMaxContextLength = limitState.maxContextLength;
  const initialMaxCostUsd = limitState.maxCostUsd;
  const sessionStartTime = Date.now();
  const responseTimestamp: ResponseTimestamp = { lastResponseAt: 0 };
  const invocationStartMessageCount = input.contextMessages?.length ?? 0;

  const getNudgeText = createNudgeDecider(
    limitState,
    sessionStartTime,
    input.thinkingLevel ?? "off",
    responseTimestamp,
    input.metaReminder,
    input.progressThresholdSeconds,
  );

  const transformContext = createInternalNudgeTransform(invocationStartMessageCount, limitState, getNudgeText, logger);

  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model: resolvedModel.model,
      thinkingLevel: input.thinkingLevel ?? "off",
      tools: input.tools,
    },
    convertToLlm,
    transformContext,
    getApiKey: (provider: string) => input.authStorage.getApiKey(provider),
    streamFn,
    steeringMode: "all",
  });

  if (input.contextMessages) {
    agent.replaceMessages(convertContextToAgentMessages(input.contextMessages, resolvedModel));
  }

  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd: process.cwd(),
    resourceLoader,
    modelRegistry,
    baseToolsOverride: Object.fromEntries(input.tools.map((tool) => [tool.name, tool])),
  });

  applySystemPromptOverrideToSession(session, input.systemPrompt);

  const visionFallbackModel = resolveVisionFallbackModel(
    input.modelAdapter,
    input.visionFallbackModel,
    resolvedModel.spec.provider,
    resolvedModel.spec.modelId,
  );

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_end") {
      // Track peak context length and cumulative cost from this assistant turn.
      const msg = event.message as { usage?: { input: number; cacheRead: number; cacheWrite: number; cost: { total: number } }; stopReason?: string };
      if (msg.usage) {
        const turnContext = msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite;
        limitState.peakContextLength = Math.max(limitState.peakContextLength, turnContext);
        limitState.cumulativeCost += msg.usage.cost.total;
      }

      const stopReason = msg.stopReason;
      const limitReached =
        limitState.peakContextLength >= limitState.maxContextLength ||
        limitState.cumulativeCost >= limitState.maxCostUsd;

      // Session-limit nudges are injected ephemerally via transformContext
      // (see createInternalNudgeTransform above).  They appear in LLM context
      // but are never queued as steering messages, so they cannot trigger
      // extra turns or cause off-topic replies.
      if (limitReached && stopReason === "toolUse") {
        limitState.turnsSinceSoftLimit += 1;
      }
      if (limitReached && limitState.turnsSinceSoftLimit >= 10) { // purely a safety vent
        logger.warn("Exceeding session limits, aborting session prompt loop.");
        void session.abort();
      }

      return;
    }

    if (event.type === "tool_execution_end" && !event.isError) {
      if (!visionState.activated && visionFallbackModel && hasImageToolOutput(event.result)) {
        visionState.activated = true;
        visionState.model = visionFallbackModel.model;
        // setModel ensures correctness for subsequent session.prompt() calls
        // (e.g. empty-completion retry), but won't help the current loop
        // iteration — the streamFn override handles that.
        agent.setModel(visionFallbackModel.model);
      }
    }
  });

  return {
    session,
    agent,
    responseTimestamp,
    ensureProviderKey: async (provider: string) => {
      const key = await input.authStorage.getApiKey(provider);
      if (!key) {
        throw new Error(`No API key configured for provider '${provider}'. Add it to auth.json.`);
      }
    },
    getVisionFallbackActivated: () => visionState.activated,
    bumpSessionLimits: (tokens: number, costUsd: number) => {
      // Floor: bump by at least 10% of the original configured limit.
      const minTokens = Math.ceil(initialMaxContextLength * 0.1);
      const minCost = initialMaxCostUsd * 0.1;
      limitState.maxContextLength += Math.max(tokens, minTokens);
      limitState.maxCostUsd += Math.max(costUsd, minCost);
    },
    dispose: () => {
      unsubscribe();
      session.dispose();
    },
  };
}

function applySystemPromptOverrideToSession(session: AgentSession, override: string): void {
  session.agent.setSystemPrompt(override);
  const state = session as unknown as {
    _baseSystemPrompt: string;
    _rebuildSystemPrompt: () => string;
  };
  state._baseSystemPrompt = override;
  state._rebuildSystemPrompt = () => override;
}

function convertContextToAgentMessages(
  contextMessages: Message[],
  _resolvedModel: ResolvedPiAiModel,
): AgentMessage[] {
  const now = Date.now();

  return contextMessages.map((message, index): AgentMessage => {
    // Ensure sequential timestamps for ordering within the agent session.
    return { ...message, timestamp: now + index } as AgentMessage;
  });
}

function createTracingStreamFn(
  logger: Logger,
  maxChars: number,
  visionState: { activated: boolean; model: ResolvedPiAiModel["model"] | null },
): StreamFn {
  return (model, context, options) => {
    const effectiveModel = (visionState.activated && visionState.model) ? visionState.model : model;
    return streamSimple(effectiveModel, context, {
      ...options,
      onPayload: (payload: unknown) => {
        logger.debug("llm_io payload agent_stream", safeJson(payload, maxChars));
      },
    });
  };
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
  try {
    const json = JSON.stringify(value);
    return json.includes('"type":"image"') || json.includes('"kind":"image"');
  } catch {
    return false;
  }
}
