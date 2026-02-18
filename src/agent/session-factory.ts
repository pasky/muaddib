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

  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model: resolvedModel.model,
      thinkingLevel: input.thinkingLevel ?? "off",
      tools: input.tools,
    },
    convertToLlm,
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

  const rawIterations = Number(input.maxIterations);
  const maxIterations = Number.isFinite(rawIterations) && rawIterations >= 1
    ? Math.floor(rawIterations)
    : DEFAULT_MAX_ITERATIONS;
  const visionFallbackModel = resolveVisionFallbackModel(
    input.modelAdapter,
    input.visionFallbackModel,
    resolvedModel.spec.provider,
    resolvedModel.spec.modelId,
  );

  let turnCount = 0;
  let visionFallbackActivated = false;
  const sessionStartTime = Date.now();
  const progressThreshold = input.progressThresholdSeconds;
  const progressReportTool = input.tools.find((t): t is ProgressReportTool => t.name === "progress_report") as ProgressReportTool | undefined;
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

      if (turnCount < maxIterations && stopReason === "toolUse") {
        const parts: string[] = [];

        if (input.metaReminder) {
          parts.push(input.metaReminder);
        }

        // Progress report nudge: fire when elapsed >= threshold (debounced from last actual
        // progress_report delivery, matching Python's max(start, executor._last_sent)).
        if (progressThreshold != null && turnCount < maxIterations - 2) {
          const now = Date.now();
          const lastActivity = Math.max(sessionStartTime, progressReportTool?.lastSentAt ?? 0);
          const elapsedSinceLastReport = (now - lastActivity) / 1000;
          const tl = input.thinkingLevel ?? "off";
          const isFirstTurnHighReasoning = turnCount === 1 &&
            (tl === "medium" || tl === "high" || tl === "xhigh");

          if (
            isFirstTurnHighReasoning ||
            (elapsedSinceLastReport >= progressThreshold)
          ) {
            parts.push("If you are going to call more tools, you MUST ALSO use the progress_report tool now.");
          }
        }

        if (parts.length > 0) {
          const hasQueuedMessages = agent.hasQueuedMessages();
          if (hasQueuedMessages) {
            logger.debug(`Skipping steering meta injection because agent already has queued messages: turnCount=${turnCount}, stopReason=${stopReason}`);
          } else {
            logger.debug(`Injecting steering meta: turnCount=${turnCount}, stopReason=${stopReason}, hasMetaReminder=${!!input.metaReminder}, hasProgressNudge=${parts.length > (input.metaReminder ? 1 : 0)}`);
            agent.steer({
              role: "user",
              content: [{ type: "text", text: `<meta>${parts.join(" ")}</meta>` }],
              timestamp: Date.now(),
            });
          }
        }
      }

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
