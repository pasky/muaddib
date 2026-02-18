import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getMuaddibHome, resolveMuaddibPath } from "./paths.js";

// ── snake_case → camelCase recursive key transform ─────────────────────

function camelCaseKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function camelCaseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelCaseKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [camelCaseKey(k), camelCaseKeys(v)]),
    );
  }
  return value;
}

// ── Config interfaces (camelCase) ──────────────────────────────────────

interface ActorConfig {
  maxIterations?: number;
  maxCompletionRetries?: number;
  llmDebugMaxChars?: number;
  progress?: {
    thresholdSeconds?: number;
    minIntervalSeconds?: number;
  };
}

export interface ArtifactsConfig {
  path?: string;
  url?: string;
}

export interface OracleConfig {
  model?: string;
  prompt?: string;
  maxIterations?: number;
}

export interface ImageGenConfig {
  model?: string;
  timeoutMs?: number;
}

export interface JinaConfig {
  maxWebContentLength?: number;
  maxImageBytes?: number;
}

export interface SpritesConfig {
  executeTimeoutMs?: number;
}

export interface ToolsConfig {
  artifacts?: ArtifactsConfig;
  oracle?: OracleConfig;
  imageGen?: ImageGenConfig;
  jina?: JinaConfig;
  sprites?: SpritesConfig;
  summary?: { model?: string };
}

interface ContextReducerConfig {
  model?: string;
  prompt?: string;
}

interface ChroniclerConfig {
  model?: string;
  database?: { path?: string };
  paragraphsPerChapter?: number;
  arcModels?: Record<string, string>;
  quests?: {
    arcs?: string[];
    promptReminder?: string;
    cooldown?: number;
  };
}

export interface OpenRouterProviderConfig {
  baseUrl?: string;
}

export interface DeepSeekProviderConfig {
  baseUrl?: string;
}

export interface ProvidersConfig {
  openrouter?: OpenRouterProviderConfig;
  deepseek?: DeepSeekProviderConfig;
}

interface HistoryConfig {
  database?: { path?: string };
}

interface RouterConfig {
  refusalFallbackModel?: string;
}

// ── Mode / Command config ──────────────────────────────────────────────

export interface ModeConfig {
  model?: string | string[];
  historySize?: number;
  reasoningEffort?: string;
  allowedTools?: string[];
  steering?: boolean;
  autoReduceContext?: boolean;
  includeChapterSummary?: boolean;
  visionModel?: string;
  prompt?: string;
  prompt_reminder?: string;
  triggers: Record<string, Record<string, unknown>>;
}

export interface ModeClassifierConfig {
  labels: Record<string, string>;
  fallbackLabel?: string;
  model: string;
  prompt?: string;
}

export interface CommandConfig {
  historySize: number;
  responseMaxBytes?: number;
  debounce?: number;
  rateLimit?: number;
  ratePeriod?: number;
  defaultMode?: string;
  channelModes?: Record<string, string>;
  ignoreUsers?: string[];
  modes: Record<string, ModeConfig>;
  modeClassifier: ModeClassifierConfig;
}

// ── Room config ────────────────────────────────────────────────────────

interface SlackWorkspaceConfig {
  name?: string;
}

export interface ProactiveRoomConfig {
  interjecting?: string[];
  debounceSeconds?: number;
  historySize?: number;
  rateLimit?: number;
  ratePeriod?: number;
  interjectThreshold?: number;
  models?: {
    validation?: string[];
    serious?: string;
  };
  prompts?: {
    interject?: string;
    seriousExtra?: string;
  };
}

export interface RoomConfig {
  enabled?: boolean;
  command?: CommandConfig;
  proactive?: ProactiveRoomConfig;
  promptVars?: Record<string, string>;
  varlink?: { socketPath?: string };
  botName?: string;
  workspaces?: Record<string, SlackWorkspaceConfig>;
  replyStartThread?: { channel?: boolean; dm?: boolean };
  replyEditDebounceSeconds?: number;
  reconnect?: { enabled?: boolean; delayMs?: number; maxAttempts?: number };
}

// ── Internal typed settings shape ──────────────────────────────────────

interface MuaddibSettings {
  actor?: ActorConfig;
  tools?: ToolsConfig;
  contextReducer?: ContextReducerConfig;
  chronicler?: ChroniclerConfig;
  providers?: Record<string, { baseUrl?: string }>;
  history?: HistoryConfig;
  router?: RouterConfig;
  rooms?: Record<string, RoomConfig>;
  quests?: unknown;
}

/** Recursively makes all properties optional. */
type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

// ── Deep merge with room-specific semantics ────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges two room config objects with room-specific semantics:
 * - `ignoreUsers` arrays are concatenated (not replaced) at any nesting depth
 * - `promptVars` string values are concatenated (not replaced) at any nesting depth
 */
export function mergeRoomConfigs(
  base: DeepPartial<RoomConfig>,
  override: DeepPartial<RoomConfig>,
): RoomConfig {
  return deepMergeRoomConfig(
    base as Record<string, unknown>,
    override as Record<string, unknown>,
  ) as RoomConfig;
}

function deepMergeRoomConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(base)) {
    if (Array.isArray(value)) {
      result[key] = [...value];
    } else if (isObject(value)) {
      result[key] = deepMergeRoomConfig(value, {});
    } else {
      result[key] = value;
    }
  }

  for (const [key, value] of Object.entries(override)) {
    if (key === "ignoreUsers" && Array.isArray(value)) {
      const baseList = (result[key] as unknown[] | undefined) ?? [];
      result[key] = [...baseList, ...value];
      continue;
    }

    if (key === "promptVars" && isObject(value)) {
      const baseVars = (result[key] as Record<string, unknown> | undefined) ?? {};
      const mergedVars: Record<string, unknown> = { ...baseVars };
      for (const [varKey, varValue] of Object.entries(value)) {
        if (typeof mergedVars[varKey] === "string" && typeof varValue === "string") {
          mergedVars[varKey] = `${mergedVars[varKey]}${varValue}`;
        } else {
          mergedVars[varKey] = varValue;
        }
      }
      result[key] = mergedVars;
      continue;
    }

    if (Array.isArray(value)) {
      result[key] = [...value];
      continue;
    }

    if (isObject(value) && isObject(result[key])) {
      result[key] = deepMergeRoomConfig(result[key] as Record<string, unknown>, value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

// ── MuaddibConfig ──────────────────────────────────────────────────────

export class MuaddibConfig {
  private readonly data: MuaddibSettings;

  private constructor(data: MuaddibSettings) {
    this.data = data;
  }

  static load(path: string): MuaddibConfig {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return new MuaddibConfig(camelCaseKeys(raw) as MuaddibSettings);
  }

  static inMemory(overrides?: Record<string, unknown>): MuaddibConfig {
    return new MuaddibConfig(camelCaseKeys(overrides ?? {}) as MuaddibSettings);
  }

  toObject(): Record<string, unknown> {
    return this.data as unknown as Record<string, unknown>;
  }

  getActorConfig(): ActorConfig {
    return this.data.actor ?? {};
  }

  getToolsConfig(): ToolsConfig {
    const t = this.data.tools ?? {};
    const artifactsPathRaw = t.artifacts?.path;
    const resolvedArtifactsPath = artifactsPathRaw
      ? resolveMuaddibPath(artifactsPathRaw, join(getMuaddibHome(), "artifacts"))
      : undefined;

    return {
      ...t,
      artifacts: {
        ...t.artifacts,
        path: resolvedArtifactsPath,
      },
    };
  }

  getContextReducerConfig(): ContextReducerConfig {
    return this.data.contextReducer ?? {};
  }

  getChroniclerConfig(): ChroniclerConfig {
    return this.data.chronicler ?? {};
  }

  getProvidersConfig(): ProvidersConfig {
    const p = this.data.providers;
    return {
      openrouter: { baseUrl: p?.openrouter?.baseUrl },
      deepseek: { baseUrl: p?.deepseek?.baseUrl },
    };
  }

  getHistoryConfig(): HistoryConfig {
    return this.data.history ?? {};
  }

  getRouterConfig(): RouterConfig {
    return this.data.router ?? {};
  }

  getRoomConfig(roomName: string): RoomConfig {
    const rooms = this.data.rooms ?? {};
    const common = rooms.common ?? {};
    const room = rooms[roomName] ?? {};
    return mergeRoomConfigs(common, room);
  }
}
