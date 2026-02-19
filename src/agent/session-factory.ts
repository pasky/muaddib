import { Agent, type AgentMessage, type AgentTool, type StreamFn, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { streamSimple, type Message } from "@mariozechner/pi-ai";
import type { ProgressReportTool } from "./tools/control.js";
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

const DEFAULT_MAX_ITERATIONS = 25;

// ── Internal nudge transform ──

/**
 * Build a function that decides what nudge text (if any) to inject for a given
 * assistant turn count. Encapsulates all policy: metaReminder, progress threshold,
 * high-reasoning first-turn special case, and near-limit suppression.
 */
function createNudgeDecider(
  maxIterations: number,
  sessionStartTime: number,
  thinkingLevel: NonNullable<CreateAgentSessionInput["thinkingLevel"]>,
  metaReminder?: string,
  progressThresholdSeconds?: number,
  progressReportTool?: ProgressReportTool,
): (turnCount: number) => string | null {
  return (turnCount: number): string | null => {
    const parts: string[] = [];

    if (metaReminder) {
      parts.push(metaReminder);
    }

    if (progressThresholdSeconds != null && turnCount < maxIterations - 2) {
      const now = Date.now();
      const lastActivity = Math.max(sessionStartTime, progressReportTool?.lastSentAt ?? 0);
      const elapsedSinceLastReport = (now - lastActivity) / 1000;
      const isFirstTurnHighReasoning =
        turnCount === 1 && (thinkingLevel === "medium" || thinkingLevel === "high" || thinkingLevel === "xhigh");

      if (isFirstTurnHighReasoning || elapsedSinceLastReport >= progressThresholdSeconds) {
        parts.push("If you are going to call more tools, you MUST ALSO use the progress_report tool now.");
      }
    }

    return parts.length > 0 ? parts.join(" ") : null;
  };
}

/**
 * Build a transformContext function that injects internal <meta> nudges
 * ephemerally into the LLM context just before each assistant call.
 *
 * Unlike agent.steer(), this does NOT add a user message to agent.state.messages.
 * The nudge is visible to the LLM but never becomes a persistent queue entry that
 * could trigger an extra turn.
 */
function createInternalNudgeTransform(
  invocationStartMessageCount: number,
  maxIterations: number,
  getNudgeText: (turnCount: number) => string | null,
  logger: Logger,
) {

  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    // Count assistant turns produced in this invocation (not from preloaded context).
    const invocationMessages = messages.slice(invocationStartMessageCount);
    const turnCount = (invocationMessages as Array<{ role: string }>).filter(
      (m) => m.role === "assistant",
    ).length;

    // Inject on the very first call (no prior assistant turns) or after a toolUse turn,
    // but never at or above the iteration ceiling.
    if (turnCount >= maxIterations) {
      return messages;
    }
    const isFirstTurn = turnCount === 0;
    const lastMsg = invocationMessages.at(-1) as { role?: string; stopReason?: string } | undefined;
    const lastIsToolResult = lastMsg?.role === "toolResult";
    // The most recent assistant message (immediately before the toolResult block)
    const lastAssistant = [...(invocationMessages as Array<{ role: string; stopReason?: string }>)]
      .reverse()
      .find((m) => m.role === "assistant");
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
  maxIterations?: number;
  visionFallbackModel?: string;
  llmDebugMaxChars?: number;
  metaReminder?: string;
  progressThresholdSeconds?: number;
  progressMinIntervalSeconds?: number;
  logger?: Logger;
}

interface CreateAgentSessionResult {
  session: AgentSession;
  agent: Agent;
  ensureProviderKey: (provider: string) => Promise<void>;
  getVisionFallbackActivated: () => boolean;
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
  const streamFn = createTracingStreamFn(logger, llmDebugMaxChars);

  // Compute maxIterations, session start, and nudge state before Agent construction
  // so they can be captured in the transformContext closure.
  const rawIterations = Number(input.maxIterations);
  const maxIterations = Number.isFinite(rawIterations) && rawIterations >= 1
    ? Math.floor(rawIterations)
    : DEFAULT_MAX_ITERATIONS;
  const sessionStartTime = Date.now();
  const progressReportTool = input.tools.find(
    (t): t is ProgressReportTool => t.name === "progress_report",
  ) as ProgressReportTool | undefined;
  const invocationStartMessageCount = input.contextMessages?.length ?? 0;

  const getNudgeText = createNudgeDecider(
    maxIterations,
    sessionStartTime,
    input.thinkingLevel ?? "off",
    input.metaReminder,
    input.progressThresholdSeconds,
    progressReportTool,
  );

  const transformContext = createInternalNudgeTransform(invocationStartMessageCount, maxIterations, getNudgeText, logger);

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

  let turnCount = 0;
  let visionFallbackActivated = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_end") {
      turnCount += 1;
      if (turnCount >= maxIterations) {
        agent.steer({
          role: "user",
          content: [
            {
              type: "text",
              text:
                "<meta>You have reached your iteration limit. Provide your final text response now. Do not use any more tools.</meta>",
            },
          ],
          timestamp: Date.now(),
        });
      }
      if (turnCount >= maxIterations + 2) {
        logger.warn("Exceeding max iterations, aborting session prompt loop.");
        void session.abort();
      }

      const stopReason = (event.message as { stopReason?: string }).stopReason;

      // Warn when assistant produces text alongside tool calls — may indicate confused output
      if (stopReason === "toolUse") {
        const content = (event.message as { content?: Array<{ type: string }> }).content;
        if (content && content.some((b) => b.type === "text") && content.some((b) => b.type === "toolCall")) {
          const textSnippet = content
            .filter((b): b is { type: string; text?: string } => b.type === "text")
            .map((b) => b.text ?? "")
            .join(" | ");
          logger.warn(`Turn ${turnCount}: assistant produced text output alongside tool_use: ${textSnippet}`);
        }
      }

      // Internal reminder and progress nudges are injected ephemerally via
      // transformContext (see createInternalNudgeTransform above). They appear
      // in LLM context but are never queued as steering messages, so they cannot
      // trigger extra turns or cause off-topic replies.

      return;
    }

    if (event.type === "tool_execution_end" && !event.isError) {
      if (!visionFallbackActivated && visionFallbackModel && hasImageToolOutput(event.result)) {
        agent.setModel(visionFallbackModel.model);
        visionFallbackActivated = true;
      }
    }
  });

  return {
    session,
    agent,
    ensureProviderKey: async (provider: string) => {
      const key = await input.authStorage.getApiKey(provider);
      if (!key) {
        throw new Error(`No API key configured for provider '${provider}'. Add it to auth.json.`);
      }
    },
    getVisionFallbackActivated: () => visionFallbackActivated,
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

function createTracingStreamFn(logger: Logger, maxChars: number): StreamFn {
  return (model, context, options) => {
    return streamSimple(model, context, {
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
