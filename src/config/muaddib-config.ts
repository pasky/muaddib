import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getMuaddibHome, resolveMuaddibPath } from "./paths.js";
import type { CommandConfig } from "../rooms/command/resolver.js";

// ── Config section interfaces ──────────────────────────────────────────

interface ActorConfig {
  maxIterations?: number;
  maxCompletionRetries?: number;
  llmDebugMaxChars?: number;
}

interface ArtifactsConfig {
  path?: string;
  url?: string;
}

interface OracleConfig {
  model?: string;
  prompt?: string;
}

interface ImageGenConfig {
  model?: string;
}

interface JinaConfig {
  apiKey?: string;
}

interface SpritesConfig {
  token?: string;
}

interface SummaryConfig {
  model?: string;
}

interface ToolsConfig {
  artifacts?: ArtifactsConfig;
  oracle?: OracleConfig;
  imageGen?: ImageGenConfig;
  jina?: JinaConfig;
  sprites?: SpritesConfig;
  summary?: SummaryConfig;
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
}

interface OpenRouterProviderConfig {
  baseUrl?: string;
}

interface DeepSeekProviderConfig {
  baseUrl?: string;
}

interface ProvidersConfig {
  openrouter?: OpenRouterProviderConfig;
  deepseek?: DeepSeekProviderConfig;
}

interface HistoryConfig {
  database?: { path?: string };
}

interface RouterConfig {
  refusalFallbackModel?: string;
}

interface RoomVarlinkConfig {
  socket_path?: string;
}

interface SlackWorkspaceConfig {
  bot_token?: string;
  name?: string;
}

interface ProactiveRoomConfig {
  interjecting?: string[];
  debounce_seconds?: number;
  history_size?: number;
  rate_limit?: number;
  rate_period?: number;
  interject_threshold?: number;
  models?: {
    validation?: string[];
    serious?: string;
  };
  prompts?: {
    interject?: string;
    serious_extra?: string;
  };
}

interface RoomConfig {
  enabled?: boolean;
  command?: CommandConfig;
  proactive?: ProactiveRoomConfig;
  prompt_vars?: Record<string, string>;
  varlink?: RoomVarlinkConfig;
  token?: string;
  bot_name?: string;
  app_token?: string;
  workspaces?: Record<string, SlackWorkspaceConfig>;
  reply_start_thread?: {
    channel?: boolean;
    dm?: boolean;
  };
  reply_edit_debounce_seconds?: number;
  reconnect?: {
    enabled?: boolean;
    delay_ms?: number;
    max_attempts?: number;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    const normalized = stringOrUndefined(entry);
    if (!normalized) {
      continue;
    }
    result[key] = normalized;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function toSlackWorkspaces(value: unknown): Record<string, SlackWorkspaceConfig> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const result: Record<string, SlackWorkspaceConfig> = {};
  for (const [workspaceId, rawWorkspace] of Object.entries(record)) {
    const workspace = asRecord(rawWorkspace);
    if (!workspace) {
      result[workspaceId] = {};
      continue;
    }

    result[workspaceId] = {
      bot_token: stringOrUndefined(workspace.bot_token),
      name: stringOrUndefined(workspace.name),
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

// ── Deep merge (moved from rooms/command/config.ts) ────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(base)) {
    if (Array.isArray(value)) {
      result[key] = [...value];
    } else if (isObject(value)) {
      result[key] = deepMergeConfig(value, {});
    } else {
      result[key] = value;
    }
  }

  for (const [key, value] of Object.entries(override)) {
    if (key === "ignore_users" && Array.isArray(value)) {
      const baseList = (result[key] as unknown[] | undefined) ?? [];
      result[key] = [...baseList, ...value];
      continue;
    }

    if (key === "prompt_vars" && isObject(value)) {
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
      result[key] = deepMergeConfig(result[key] as Record<string, unknown>, value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

// ── MuaddibConfig ──────────────────────────────────────────────────────

export class MuaddibConfig {
  constructor(private readonly data: Record<string, unknown>) {}

  static load(path: string): MuaddibConfig {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return new MuaddibConfig(raw);
  }

  static inMemory(overrides?: Record<string, unknown>): MuaddibConfig {
    return new MuaddibConfig(overrides ?? {});
  }

  toObject(): Record<string, unknown> {
    return this.data;
  }

  getActorConfig(): ActorConfig {
    const actor = asRecord(this.data.actor);
    return {
      maxIterations: numberOrUndefined(actor?.max_iterations),
      maxCompletionRetries: numberOrUndefined(actor?.max_completion_retries),
      llmDebugMaxChars: numberOrUndefined(actor?.llm_debug_max_chars),
    };
  }

  getToolsConfig(): ToolsConfig {
    const tools = asRecord(this.data.tools);
    const artifacts = asRecord(tools?.artifacts);
    const oracle = asRecord(tools?.oracle);
    const imageGen = asRecord(tools?.image_gen);
    const jina = asRecord(tools?.jina);
    const sprites = asRecord(tools?.sprites);
    const summary = asRecord(tools?.summary);

    const artifactsPathRaw = stringOrUndefined(artifacts?.path);
    const resolvedArtifactsPath = artifactsPathRaw
      ? resolveMuaddibPath(artifactsPathRaw, join(getMuaddibHome(), "artifacts"))
      : undefined;

    return {
      artifacts: {
        path: resolvedArtifactsPath,
        url: stringOrUndefined(artifacts?.url),
      },
      oracle: {
        model: stringOrUndefined(oracle?.model),
        prompt: stringOrUndefined(oracle?.prompt),
      },
      imageGen: {
        model: stringOrUndefined(imageGen?.model),
      },
      jina: {
        apiKey: stringOrUndefined(jina?.api_key),
      },
      sprites: {
        token: stringOrUndefined(sprites?.token),
      },
      summary: {
        model: stringOrUndefined(summary?.model),
      },
    };
  }

  getContextReducerConfig(): ContextReducerConfig {
    const cr = asRecord(this.data.context_reducer);
    return {
      model: stringOrUndefined(cr?.model),
      prompt: stringOrUndefined(cr?.prompt),
    };
  }

  getChroniclerConfig(): ChroniclerConfig {
    const chronicler = asRecord(this.data.chronicler);
    if (!chronicler) {
      return {};
    }
    const db = asRecord(chronicler.database);
    return {
      model: stringOrUndefined(chronicler.model),
      database: { path: stringOrUndefined(db?.path) },
      paragraphsPerChapter: numberOrUndefined(chronicler.paragraphs_per_chapter),
      arcModels: toStringRecord(chronicler.arc_models),
    };
  }

  getProvidersConfig(): ProvidersConfig {
    const providers = asRecord(this.data.providers);
    const openrouter = asRecord(providers?.openrouter);
    const deepseek = asRecord(providers?.deepseek);

    return {
      openrouter: {
        baseUrl: stringOrUndefined(openrouter?.base_url),
      },
      deepseek: {
        baseUrl: stringOrUndefined(deepseek?.url) ?? stringOrUndefined(deepseek?.base_url),
      },
    };
  }

  getProviderStaticKeys(): Record<string, string> {
    const providers = asRecord(this.data.providers) ?? {};
    const keys: Record<string, string> = {};

    for (const [provider, rawProviderConfig] of Object.entries(providers)) {
      const providerConfig = asRecord(rawProviderConfig);
      if (!providerConfig) {
        continue;
      }

      const key = providerConfig.key;
      if (typeof key === "string") {
        const trimmed = key.trim();
        if (trimmed.length > 0) {
          keys[provider] = trimmed;
        }
      }
    }

    return keys;
  }

  getHistoryConfig(): HistoryConfig {
    const history = asRecord(this.data.history);
    const db = asRecord(history?.database);
    return {
      database: { path: stringOrUndefined(db?.path) },
    };
  }

  getRouterConfig(): RouterConfig {
    const router = asRecord(this.data.router);
    return {
      refusalFallbackModel: stringOrUndefined(router?.refusal_fallback_model),
    };
  }

  getRoomConfig(roomName: string): RoomConfig {
    const rooms = asRecord(this.data.rooms) ?? {};
    const common = asRecord(rooms.common) ?? {};
    const room = asRecord(rooms[roomName]) ?? {};
    const merged = deepMergeConfig(common, room);

    const command = asRecord(merged.command);
    const proactive = asRecord(merged.proactive);
    const varlink = asRecord(merged.varlink);
    const replyStartThread = asRecord(merged.reply_start_thread);
    const reconnect = asRecord(merged.reconnect);

    const proactiveModels = asRecord(proactive?.models);
    const proactivePrompts = asRecord(proactive?.prompts);

    return {
      enabled: typeof merged.enabled === "boolean" ? merged.enabled : undefined,
      command: command as CommandConfig | undefined,
      proactive: proactive
        ? {
            interjecting: Array.isArray(proactive.interjecting) ? (proactive.interjecting as string[]) : undefined,
            debounce_seconds: numberOrUndefined(proactive.debounce_seconds),
            history_size: numberOrUndefined(proactive.history_size),
            rate_limit: numberOrUndefined(proactive.rate_limit),
            rate_period: numberOrUndefined(proactive.rate_period),
            interject_threshold: numberOrUndefined(proactive.interject_threshold),
            models: proactiveModels
              ? {
                  validation: Array.isArray(proactiveModels.validation) ? (proactiveModels.validation as string[]) : undefined,
                  serious: stringOrUndefined(proactiveModels.serious),
                }
              : undefined,
            prompts: proactivePrompts
              ? {
                  interject: stringOrUndefined(proactivePrompts.interject),
                  serious_extra: stringOrUndefined(proactivePrompts.serious_extra),
                }
              : undefined,
          }
        : undefined,
      prompt_vars: toStringRecord(merged.prompt_vars),
      varlink: {
        socket_path: stringOrUndefined(varlink?.socket_path),
      },
      token: stringOrUndefined(merged.token),
      bot_name: stringOrUndefined(merged.bot_name),
      app_token: stringOrUndefined(merged.app_token),
      workspaces: toSlackWorkspaces(merged.workspaces),
      reply_start_thread: {
        channel: typeof replyStartThread?.channel === "boolean" ? replyStartThread.channel : undefined,
        dm: typeof replyStartThread?.dm === "boolean" ? replyStartThread.dm : undefined,
      },
      reply_edit_debounce_seconds: numberOrUndefined(merged.reply_edit_debounce_seconds),
      reconnect: {
        enabled: typeof reconnect?.enabled === "boolean" ? reconnect.enabled : undefined,
        delay_ms: numberOrUndefined(reconnect?.delay_ms),
        max_attempts: numberOrUndefined(reconnect?.max_attempts),
      },
    };
  }
}
