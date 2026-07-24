import { Agent, type AgentMessage, type AgentTool, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, StopReason } from "@earendil-works/pi-ai";
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
  type ResponseTimestamp,
  type TurnUsage,
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

const DEFAULT_MAX_CONTEXT_LENGTH = 100_000;
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
  getAppendSystemPrompt: () => [],
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
  getVisionFallbackActivated: () => boolean;
  bumpSessionLimits: (tokens: number, costUsd: number) => void;
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
  const streamFn = createTracingStreamFn(logger, llmDebugMaxChars, visionState);

  // Compute session limits, session start, and nudge state before Agent construction
  // so they can be captured in the transformContext closure.
  const limits = new SessionLimits(
    input.sessionLimits?.maxContextLength ?? DEFAULT_MAX_CONTEXT_LENGTH,
    input.sessionLimits?.maxCostUsd ?? DEFAULT_MAX_COST_USD,
  );
  const sessionStartTime = Date.now();
  const responseTimestamp: ResponseTimestamp = { lastResponseAt: 0 };
  const invocationStartMessageCount = input.contextMessages?.length ?? 0;

  const getNudgeText = createNudgeDecider(
    limits,
    sessionStartTime,
    input.thinkingLevel ?? "off",
    responseTimestamp,
    input.metaReminder,
    input.progressThresholdSeconds,
  );

  const transformContext = createInternalNudgeTransform(invocationStartMessageCount, limits, getNudgeText, logger);

  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
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
    agent.state.messages = convertContextToAgentMessages(input.contextMessages, resolvedModel);
  } else if (sessionFile) {
    // Resuming an existing session file — prime the agent with its history
    // so a follow-up prompt can re-use the provider's prompt cache.
    const resumed = sessionManager.buildSessionContext();
    if (resumed.messages.length > 0) {
      agent.state.messages = resumed.messages;
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

  applySystemPromptOverrideToSession(session, input.systemPrompt);

  const visionFallbackModel = await resolveVisionFallbackModel(
    input.modelAdapter,
    input.visionFallbackModel,
    resolvedModel.spec.provider,
    resolvedModel.spec.modelId,
  );

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_end") {
      const msg = event.message as { usage?: TurnUsage; stopReason?: StopReason };
      // Session-limit nudges are injected ephemerally via transformContext
      // (see createInternalNudgeTransform in session-limits.ts).  They appear
      // in LLM context but are never queued as steering messages, so they
      // cannot trigger extra turns or cause off-topic replies.  recordTurn
      // returns true only when the post-limit safety vent trips.
      if (limits.recordTurn(msg.usage, msg.stopReason)) {
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
        agent.state.model = visionFallbackModel.model;
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
    getVisionFallbackActivated: () => visionState.activated,
    bumpSessionLimits: (tokens: number, costUsd: number) => limits.bump(tokens, costUsd),
    dispose: () => {
      unsubscribe();
      session.dispose();
    },
  };
}

function applySystemPromptOverrideToSession(session: AgentSession, override: string): void {
  session.agent.state.systemPrompt = override;
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
    return piAiModels.streamSimple(effectiveModel, context, {
      ...options,
      onPayload: (payload: unknown) => {
        logger.debug("llm_io payload agent_stream", safeJson(payload, maxChars));
      },
    });
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
