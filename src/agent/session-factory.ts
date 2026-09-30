import { Agent, type AgentMessage, type AgentTool, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemMessage,
  type AssistantMessage,
  type Message,
  type StopReason,
  type SystemMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  AgentSession,
  SessionManager,
  SettingsManager,
  convertToLlm,
  createExtensionRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

import type { AuthStore } from "../auth/auth-store.js";
import {
  SessionLimits,
  createInternalNudgeTransform,
  createNudgeDecider,
  type InvocationStart,
  type ResponseTimestamp,
} from "./session-limits.js";
import { PiAiModelAdapter, type ResolvedPiAiModel } from "../models/pi-ai-model-adapter.js";
import { piAiModels } from "../models/pi-ai-models.js";
import type { Logger } from "../app/logging.js";
import { safeJson } from "./debug-utils.js";
import type { SessionLimitsConfig } from "../config/muaddib-config.js";
import {
  MUADDIB_STEERED_PASSIVE_CUSTOM_TYPE,
  renderSteeredPassive,
  type SteeredPassiveMessage,
} from "../rooms/message.js";

/**
 * Wrap pi-coding-agent's `convertToLlm` so that any `muaddib.steered_passive`
 * custom message in the transcript is rendered into a regular user message
 * with the correct steering wording, chosen based on its actual predecessor.
 *
 * The predecessor is the nearest non-(`user`/`custom`) message before the
 * steered entry. If that predecessor is a `toolResult`, the agent is mid-task
 * and we use the "continue your in-progress work" wording; otherwise we use
 * the post-assistant-text wording (which includes the NULL hint).
 *
 * Running this rewrite at `convertToLlm` time — i.e. immediately before each
 * LLM call, after steering/follow-up draining — means the custom message is
 * already at its real final position in the transcript, so the variant we
 * pick is exactly what the LLM is about to see.
 */
export function createSteeredPassiveAwareConvertToLlm(): typeof convertToLlm {
  return (messages: AgentMessage[]) => {
    const rewritten = messages.map((m, i) => {
      if (
        m.role !== "custom" ||
        (m as SteeredPassiveMessage).customType !== MUADDIB_STEERED_PASSIVE_CUSTOM_TYPE
      ) {
        return m;
      }
      // Walk back past further user/custom entries (batched steers, ephemeral
      // nudges, retry prompts) to find the real predecessor.
      let j = i - 1;
      while (j >= 0 && (messages[j].role === "user" || messages[j].role === "custom")) j--;
      const predecessor = j >= 0 ? messages[j] : undefined;
      const afterTool = predecessor?.role === "toolResult";
      const body = (m as SteeredPassiveMessage).content;
      return {
        role: "user",
        content: [{ type: "text", text: renderSteeredPassive(body, { afterTool }) }],
        timestamp: m.timestamp,
      } as AgentMessage;
    });
    return convertToLlm(rewritten);
  };
}

/**
 * No context ceiling unless one is configured: pi's auto-compaction summarizes
 * the transcript when it approaches the model's real context window, so cost
 * (and the safety vent) is what bounds a session.
 */
const DEFAULT_MAX_CONTEXT_LENGTH = Number.POSITIVE_INFINITY;
const DEFAULT_MAX_COST_USD = 1.0;

/** Custom session entry type used to stash the muaddib system prompt so
 * `session_query` can replay the exact prefix on a resumed session. */
export const MUADDIB_SYSTEM_PROMPT_CUSTOM_TYPE = "muaddib.system_prompt";

/** Custom session entry type used to stash the tool schemas (name, description,
 * JSON Schema parameters) the session was created with.  `session_query`
 * replays these so the provider sees byte-for-byte the same `tools` list and
 * can hit its prompt cache on the resumed prefix. */
export const MUADDIB_TOOL_SCHEMAS_CUSTOM_TYPE = "muaddib.tool_schemas";

const EMPTY_RESOURCE_LOADER_BASE: Omit<ResourceLoader, "getExtensions" | "getSystemPrompt"> = {
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

export type RunnerLogger = Logger;

interface CreateAgentSessionInput {
  model: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  authStorage: AuthStore;
  modelAdapter: PiAiModelAdapter;
  contextMessages?: Message[];
  thinkingLevel?: ThinkingLevel;
  sessionLimits?: SessionLimitsConfig;
  visionFallbackModel?: string;
  /**
   * Models to switch to, in order, when pi is about to auto-retry a transient
   * provider error (overloaded, rate-limited, 5xx): the retry then goes to the
   * next fallback instead of hammering the same model.
   */
  overloadFallbackModels?: string[];
  llmDebugMaxChars?: number;
  metaReminder?: string;
  progressThresholdSeconds?: number;
  logger?: Logger;
  /**
   * When set, the session is persisted as a pi-coding-agent JSONL file at
   * this exact path (typically `<sessionHostDir>/.session-record.jsonl`, or a
   * sibling record file for a nested session sharing the same working dir).
   * Omit for an in-memory session.
   */
  sessionFile?: string;
}

interface CreateAgentSessionResult {
  session: AgentSession;
  agent: Agent;
  responseTimestamp: ResponseTimestamp;
  ensureProviderKey: (provider: string) => Promise<void>;
  /**
   * Switch the agent to another model (a fallback) and record it as a
   * `model_change` in a persisted session, so session_query resumes with the
   * model that actually finished the work.
   */
  switchModel: (resolved: ResolvedPiAiModel) => void;
  getVisionFallbackActivated: () => boolean;
  /** Spec of the overload fallback currently in use, or null while on the primary model. */
  getOverloadFallbackModel: () => string | null;
  bumpSessionLimits: (tokens: number, costUsd: number) => void;
  /** Usage billed since the previous take (see `SessionLimits.takeUsage`). */
  takeUsage: () => { usage: Usage; peakTurnInput: number };
  dispose: () => void;
  /** Path to the persisted session JSONL file, or `null` when in-memory. */
  sessionFile: string | null;
  /** Short session identifier (from the session header). */
  sessionId: string;
}

export async function createAgentSessionForInvocation(
  input: CreateAgentSessionInput,
): Promise<CreateAgentSessionResult> {
  const logger = input.logger ?? console;
  const resolvedModel = await input.modelAdapter.resolve(input.model);
  const sessionManager = input.sessionFile
    ? SessionManager.open(input.sessionFile)
    : SessionManager.inMemory();
  const sessionFile = sessionManager.getSessionFile() ?? null;
  const sessionId = sessionManager.getSessionId();
  if (sessionFile) {
    logger.info(`session_file ${sessionId} ${sessionFile}`);
    // Persist the effective system prompt so session_query can replay it
    // verbatim on follow-up — required for provider prompt-cache hits.
    // Skip if one is already persisted (resuming an existing file).
    const alreadyPersisted = sessionManager
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === MUADDIB_SYSTEM_PROMPT_CUSTOM_TYPE);
    if (!alreadyPersisted) {
      sessionManager.appendCustomEntry(MUADDIB_SYSTEM_PROMPT_CUSTOM_TYPE, { text: input.systemPrompt });
      const toolSchemas = input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      sessionManager.appendCustomEntry(MUADDIB_TOOL_SCHEMAS_CUSTOM_TYPE, { schemas: toolSchemas });
      // Pi only records `model_change` entries on explicit setModel/cycleModel
      // calls; the initial model from `Agent.initialState` is never written.
      // Record it ourselves so `session_query` can recover the session's model
      // on resume.
      sessionManager.appendModelChange(resolvedModel.spec.provider, resolvedModel.spec.modelId);
    }
  }
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });

  const resourceLoader: ResourceLoader = {
    ...EMPTY_RESOURCE_LOADER_BASE,
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSystemPrompt: () => input.systemPrompt,
  };

  const modelRuntime = await input.authStorage.getModelRuntime();
  const llmDebugMaxChars = Math.max(500, Math.floor(input.llmDebugMaxChars ?? 120_000));

  // Mutable vision-fallback state: when activated, prepareNextTurn switches
  // pi-agent-core's loop config to the vision-capable model so the next request
  // resolves that provider's API key. The streamFn override remains a safety net
  // against any stale model parameter captured before the config update.
  const visionState = { activated: false, model: null as ResolvedPiAiModel["model"] | null };

  // Compute session limits, session start, and nudge state before Agent construction
  // so they can be captured in the transformContext closure.
  const limits = new SessionLimits(
    resolveSessionLimit("maxContextLength", input.sessionLimits?.maxContextLength, DEFAULT_MAX_CONTEXT_LENGTH),
    resolveSessionLimit("maxCostUsd", input.sessionLimits?.maxCostUsd, DEFAULT_MAX_COST_USD),
  );
  // Every LLM call of the session passes through the stream function: agent
  // turns, auto-retries, and compaction summarizations (pi calls
  // agent.streamFunction for those, and reports no usage for the ones it then
  // rejects, e.g. a summary cut off by stopReason=length). Accounting here is
  // the only way nothing billed escapes the budget.
  const streamFn = createTracingStreamFn(logger, llmDebugMaxChars, visionState, (message) => {
    limits.recordUsage(message.usage);
  });
  const sessionStartTime = Date.now();
  const responseTimestamp: ResponseTimestamp = { lastResponseAt: 0 };
  // Marks where preloaded content ends and this invocation's own turns begin.
  // Held as message identity rather than an index because compaction rewrites
  // the message list; filled in below, once the preload (explicit context or
  // resumed session history) is in place.
  const invocationStart: InvocationStart = { boundary: null };

  const getNudgeText = createNudgeDecider(
    limits,
    sessionStartTime,
    input.thinkingLevel ?? "off",
    responseTimestamp,
    input.metaReminder,
    input.progressThresholdSeconds,
  );

  const transformContext = pinSystemPrompt(
    input.systemPrompt,
    createInternalNudgeTransform(invocationStart, limits, getNudgeText, logger),
  );

  const agent = new Agent({
    initialState: {
      model: resolvedModel.model,
      thinkingLevel: input.thinkingLevel ?? "off",
      tools: input.tools,
    },
    convertToLlm: createSteeredPassiveAwareConvertToLlm(),
    transformContext,
    getApiKey: (provider: string) => input.authStorage.getApiKey(provider),
    streamFn,
    prepareNextTurn: () => {
      if (visionState.activated && visionState.model) {
        return { model: visionState.model };
      }
      return undefined;
    },
    steeringMode: "all",
  });

  if (input.contextMessages) {
    // The session manager is pi's canonical provider context: every request is
    // projected from its branch, so preloaded context must live there.
    for (const message of withSequentialTimestamps(input.contextMessages)) {
      sessionManager.appendMessage(message);
    }
  }

  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd: process.cwd(),
    resourceLoader,
    modelRuntime,
    baseToolsOverride: Object.fromEntries(input.tools.map((tool) => [tool.name, tool])),
  });

  // Mirror the session branch (preloaded context, or a resumed session file's
  // history) into agent state. Requests project plain message entries as the
  // same objects, so transformContext finds the boundary below by identity
  // (custom/summary/context-edited entries are rebuilt per projection; if the
  // boundary is one of those, or compaction drops it, turn counting falls back
  // to the whole context).
  session.refreshContext();
  invocationStart.boundary = session.messages.at(-1) ?? null;

  const visionFallbackModel = await resolveVisionFallbackModel(
    input.modelAdapter,
    input.visionFallbackModel,
    resolvedModel.spec.provider,
    resolvedModel.spec.modelId,
  );

  const switchModel = (resolved: ResolvedPiAiModel): void => {
    agent.state.model = resolved.model;
    if (sessionFile) {
      sessionManager.appendModelChange(resolved.spec.provider, resolved.spec.modelId);
    }
  };

  // Resolved upfront: the auto_retry_start listener must switch synchronously,
  // before pi removes the failed message and schedules agent.continue().
  const overloadFallbacks: Array<{ spec: string; resolved: ResolvedPiAiModel }> = [];
  for (const spec of input.overloadFallbackModels ?? []) {
    overloadFallbacks.push({ spec, resolved: await input.modelAdapter.resolve(spec) });
  }
  let overloadFallbackIndex = -1;
  // The chain belongs to the primary model and then to each fallback it
  // installs. Once something else took the model over (refusal or vision
  // fallback), a transient error is that model's problem: leave it to pi's
  // plain backoff retry. (Vision also forces its model in streamFn, so
  // switching here would pair the vision request with another provider's key.)
  let overloadChainModel: ResolvedPiAiModel["model"] = resolvedModel.model;

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "auto_retry_start") {
      // Only fires for errors pi classifies as transient. Switching
      // agent.state.model here makes the retry's continue() build its loop
      // config (model + provider API key) from the fallback.
      const next = overloadFallbacks[overloadFallbackIndex + 1];
      if (next && agent.state.model === overloadChainModel) {
        overloadFallbackIndex += 1;
        logger.warn(`Overload fallback to ${next.spec} after: ${event.errorMessage}`);
        switchModel(next.resolved);
        overloadChainModel = next.resolved.model;
      }
      return;
    }

    if (event.type === "turn_end") {
      const msg = event.message as { stopReason?: StopReason };
      // Session-limit nudges are injected ephemerally via transformContext
      // (see createInternalNudgeTransform in session-limits.ts).  They appear
      // in LLM context but are never queued as steering messages, so they
      // cannot trigger extra turns or cause off-topic replies.  recordTurnEnd
      // returns true only when the post-limit safety vent trips.
      if (limits.recordTurnEnd(msg.stopReason)) {
        logger.warn("Exceeding session limits, aborting session prompt loop.");
        void session.abort();
      }

      return;
    }

    if (event.type === "compaction_start") {
      logger.info(`Context compaction started reason=${event.reason}`);
      return;
    }

    if (event.type === "compaction_end") {
      if (event.aborted || !event.result) {
        logger.warn(
          `Context compaction did not complete reason=${event.reason}${event.errorMessage ? ` error=${event.errorMessage}` : ""}`,
        );
        return;
      }
      logger.info(
        `Context compacted reason=${event.reason} tokens=${event.result.tokensBefore}→${event.result.estimatedTokensAfter ?? "?"}`,
      );
      return;
    }

    if (event.type === "tool_execution_end" && !event.isError) {
      if (!visionState.activated && visionFallbackModel && hasImageToolOutput(event.result)) {
        visionState.activated = true;
        visionState.model = visionFallbackModel.model;
        // Ensures correctness for subsequent session.prompt() calls (e.g.
        // empty-completion retry), but won't help the current loop
        // iteration — the streamFn override handles that.
        switchModel(visionFallbackModel);
      }
    }
  });

  return {
    session,
    agent,
    responseTimestamp,
    sessionFile,
    sessionId,
    ensureProviderKey: async (provider: string) => {
      const key = await input.authStorage.getApiKey(provider);
      if (!key) {
        throw new Error(`No API key configured for provider '${provider}'. Add it to auth.json.`);
      }
    },
    switchModel,
    getVisionFallbackActivated: () => visionState.activated,
    getOverloadFallbackModel: () => overloadFallbacks[overloadFallbackIndex]?.spec ?? null,
    takeUsage: () => limits.takeUsage(),
    bumpSessionLimits: (tokens: number, costUsd: number) => limits.bump(tokens, costUsd),
    dispose: () => {
      unsubscribe();
      session.dispose();
    },
  };
}

/**
 * A limit is optional, but if present it must be a positive number: with no
 * context ceiling by default, a malformed maxCostUsd would otherwise leave the
 * session unbounded (comparisons against NaN are all false).
 */
function resolveSessionLimit(name: keyof SessionLimitsConfig, value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`sessionLimits.${name} must be a finite number > 0, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * Send `systemPrompt` verbatim as the sole, leading system message of every
 * request.
 *
 * pi keeps the system prompt in the transcript as structured sections built
 * from the resource loader, and always appends sections of its own (e.g.
 * `<cwd>` of the host process), which would leak into our prompt and differ
 * across deployments. pi's own override (`before_agent_start` returning
 * `systemPrompt`) only lasts for a single `session.prompt()` run, not for a
 * direct `agent.continue()`. Pinning in transformContext covers every agent
 * request — turns, retries, steering drains — and keeps the prefix byte-stable for
 * prompt caching. The current tool loadout is replayed from the transcript.
 * (Compaction summarization calls the stream function directly with its own
 * prompt and is deliberately not affected.)
 */
function pinSystemPrompt(
  systemPrompt: string,
  inner: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  return async (messages, signal) => {
    const transformed = await inner(messages, signal);
    const current = getCurrentSystemMessage(transformed as Message[]);
    const head: SystemMessage = {
      role: "system",
      content: systemPrompt,
      ...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
      timestamp: current?.timestamp ?? 0,
    };
    return [head, ...transformed.filter((message) => message.role !== "system")];
  };
}

/** Ensure sequential timestamps for ordering within the agent session. */
function withSequentialTimestamps(contextMessages: Message[]): Message[] {
  const now = Date.now();
  return contextMessages.map((message, index) => ({ ...message, timestamp: now + index }));
}

function createTracingStreamFn(
  logger: Logger,
  maxChars: number,
  visionState: { activated: boolean; model: ResolvedPiAiModel["model"] | null },
  onResult: (message: AssistantMessage) => void,
): StreamFn {
  return (model, context, options) => {
    const effectiveModel = (visionState.activated && visionState.model) ? visionState.model : model;
    const stream = piAiModels.streamSimple(effectiveModel, context, {
      ...options,
      onPayload: (payload: unknown) => {
        logger.debug("llm_io payload agent_stream", safeJson(payload, maxChars));
      },
    });
    // result() only ever resolves (pi-ai reports failures as a final message
    // with stopReason=error); a stream ended without a result leaves this
    // listener dangling, which is harmless.
    void stream.result().then(onResult);
    return stream;
  };
}

async function resolveVisionFallbackModel(
  modelAdapter: PiAiModelAdapter,
  visionFallbackModel: string | undefined,
  primaryProvider: string,
  primaryModelId: string,
): Promise<ResolvedPiAiModel | null> {
  const candidate = visionFallbackModel?.trim();
  if (!candidate) {
    return null;
  }

  const resolved = await modelAdapter.resolve(candidate);
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
