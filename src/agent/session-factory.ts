import { Agent, type AgentMessage, type AgentTool, type StreamFn, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { streamSimple, type AssistantMessage, type UserMessage } from "@mariozechner/pi-ai";
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

import { tmpdir } from "os";
import { join } from "path";
import { PiAiModelAdapter, type ResolvedPiAiModel } from "../models/pi-ai-model-adapter.js";
import type { Logger } from "../app/logging.js";
import { emptyUsage, safeJson } from "./debug-utils.js";

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

export interface SessionFactoryContextMessage {
  role: "user" | "assistant";
  content: string;
}

interface CreateAgentSessionInput {
  model: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  modelAdapter: PiAiModelAdapter;
  contextMessages?: SessionFactoryContextMessage[];
  thinkingLevel?: ThinkingLevel;
  maxIterations?: number;
  visionFallbackModel?: string;
  llmDebugMaxChars?: number;
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

  // Use a non-existent path so AuthStorage starts empty and never touches ~/.pi/agent/auth.json.
  // All key resolution goes through the fallback resolver backed by muaddib's config.json.
  // We override set/remove/login/logout to be no-ops so keys are never persisted to disk,
  // even if upstream pi-coding-agent internals change.
  const authStorage = new AuthStorage(join(tmpdir(), "muaddib-auth-noop.json"));
  authStorage.set = () => {};
  authStorage.remove = () => {};
  authStorage.login = async () => {};
  authStorage.logout = () => {};
  const authBridge = new MuaddibConfigBackedAuthBridge(input.getApiKey);
  const modelRegistry = new ModelRegistry(authStorage);
  // Set fallback resolver AFTER ModelRegistry constructor (which overwrites it).
  authStorage.setFallbackResolver((provider) => authBridge.resolveSync(provider));
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
    getApiKey: input.getApiKey,
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
      // Resolve the key to validate it exists (and warm the bridge cache),
      // but do NOT persist to AuthStorage — all keys live in config.json only.
      await authBridge.resolveAsync(provider);
    },
    getVisionFallbackActivated: () => visionFallbackActivated,
    dispose: () => {
      unsubscribe();
      session.dispose();
    },
  };
}

class MuaddibConfigBackedAuthBridge {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined,
  ) {}

  resolveSync(provider: string): string | undefined {
    const cached = this.cache.get(provider);
    if (cached) {
      return cached;
    }

    const value = this.getApiKey?.(provider);
    if (typeof value !== "string") {
      return undefined;
    }

    const normalized = normalizeApiKey(value);
    if (!normalized) {
      return undefined;
    }

    this.cache.set(provider, normalized);
    return normalized;
  }

  async resolveAsync(provider: string): Promise<string | undefined> {
    const cached = this.cache.get(provider);
    if (cached) {
      return cached;
    }

    if (!this.getApiKey) {
      return undefined;
    }

    const value = await this.getApiKey(provider);
    if (typeof value !== "string") {
      return undefined;
    }

    const normalized = normalizeApiKey(value);
    if (!normalized) {
      return undefined;
    }

    this.cache.set(provider, normalized);
    return normalized;
  }
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
  contextMessages: SessionFactoryContextMessage[],
  resolvedModel: ResolvedPiAiModel,
): AgentMessage[] {
  const now = Date.now();

  return contextMessages.map((message, index): AgentMessage => {
    const timestamp = now + index;

    if (message.role === "assistant") {
      const assistant: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        api: resolvedModel.model.api,
        provider: resolvedModel.spec.provider,
        model: resolvedModel.spec.modelId,
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

function normalizeApiKey(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
