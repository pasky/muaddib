import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getMuaddibHome, resolveMuaddibPath } from "../app/bootstrap.js";

// ── Config section interfaces ──────────────────────────────────────────

export interface ActorConfig {
  maxIterations?: number;
  maxCompletionRetries?: number;
  llmDebugMaxChars?: number;
}

export interface ArtifactsConfig {
  path?: string;
  url?: string;
}

export interface OracleConfig {
  model?: string;
  prompt?: string;
}

export interface ImageGenConfig {
  model?: string;
}

export interface JinaConfig {
  apiKey?: string;
}

export interface SpritesConfig {
  token?: string;
}

export interface SummaryConfig {
  model?: string;
}

export interface ToolsConfig {
  artifacts?: ArtifactsConfig;
  oracle?: OracleConfig;
  imageGen?: ImageGenConfig;
  jina?: JinaConfig;
  sprites?: SpritesConfig;
  summary?: SummaryConfig;
}

export interface ContextReducerConfig {
  model?: string;
  prompt?: string;
}

export interface ChroniclerConfig {
  model?: string;
  database?: { path?: string };
  paragraphsPerChapter?: number;
  arcModels?: Record<string, string>;
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

export interface HistoryConfig {
  database?: { path?: string };
}

export interface RouterConfig {
  refusalFallbackModel?: string;
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

  /** Raw config object — for backward compat with APIs that still expect Record<string, unknown>. */
  get raw(): Record<string, unknown> {
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

  getRoomConfig(roomName: string): Record<string, unknown> {
    const rooms = asRecord(this.data.rooms) ?? {};
    const common = asRecord(rooms.common) ?? {};
    const room = asRecord(rooms[roomName]) ?? {};
    return deepMergeConfig(common, room);
  }
}
