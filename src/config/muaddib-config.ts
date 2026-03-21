import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { getMuaddibHome, resolveMuaddibPath } from "./paths.js";
import { deepMerge, isRecord } from "../utils/index.js";

// ── Config interfaces (camelCase) ──────────────────────────────────────

export interface ArtifactsConfig {
  path?: string;
  url?: string;
}

export interface OracleConfig {
  model?: string;
  prompt?: string;
  thinkingLevel?: ThinkingLevel;
  maxIterations?: number;
}

export interface DeepResearchConfig {
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

export interface VisitWebpageConfig {
  model?: string;
}

export interface GondolinSecretEnvConfig {
  provider: string;
  hosts: string[];
}

export type GondolinEnvValue = string | GondolinSecretEnvConfig;

export interface GondolinProfileConfig {
  env?: Record<string, GondolinEnvValue>;
}

export interface GondolinArcConfig extends GondolinProfileConfig {
  use?: string[];
}

export interface GondolinConfig {
  /**
   * IP CIDR ranges to block (both IPv4 and IPv6).
   * Example: ["2001:db8:1:2::/64", "203.0.113.0/24"]
   * Internal RFC-1918 and loopback ranges are blocked by default.
   * Exception: hostname from tools.artifacts.url is allowed even when it resolves
   * to those ranges, so the sandbox can fetch shared artifacts.
   */
  blockedCidrs?: string[];
  /**
   * Default bash command timeout in seconds.  Applied when the bash tool caller
   * does not supply an explicit timeout, and also acts as an upper bound on any
   * caller-supplied timeout.
   * Default: 270 (just under Claude's 5-minute token-cache expiry).
   */
  bashTimeoutSeconds?: number;
  /**
   * DNS resolution mode inside the VM.
   *   "open"      – real DNS servers (default upstream gondolin behaviour).
   *   "synthetic" – gondolin intercepts DNS and returns synthetic IPs, forcing all
   *                 HTTP/HTTPS traffic through the MITM layer (stronger sandboxing).
   * Default: "synthetic".
   */
  dnsMode?: "open" | "synthetic";
  /**
   * Maximum number of arc QEMU VMs that may run concurrently across all arcs.
   * When this limit is reached, new arc invocations block until a slot is freed
   * (i.e. another arc's session ends and its VM is checkpointed).
   * Must be a positive integer; unlimited concurrency is not supported.
   * Default: 8.
   */
  maxConcurrentVms?: number;
  /**
   * Maximum workspace size in MB.  When the cumulative size of files written
   * to /workspace exceeds this limit, further writes fail with ENOSPC.
   * Default: 4096 (4 GB).
   */
  workspaceSizeMb?: number;
  /**
   * Reusable named Gondolin config fragments.
   */
  profiles?: Record<string, GondolinProfileConfig>;
  /**
   * Per-arc Gondolin config fragments keyed by simple `*` globs over the raw
   * human arc string `${serverTag}#${channelName}`. `"*"` is the global baseline.
   */
  arcs?: Record<string, GondolinArcConfig>;
}

/**
 * Configuration for the agent's built-in tools (oracle, artifacts, image generation, etc.).
 * Lives under `agent.tools` in config.json.
 */
export interface MemoryConfig {
  charLimit?: number;
}

export interface SkillsConfig {
  creationThreshold?: number;
}

export interface ToolsConfig {
  artifacts?: ArtifactsConfig;
  oracle?: OracleConfig;
  deepResearch?: DeepResearchConfig;
  imageGen?: ImageGenConfig;
  jina?: JinaConfig;
  visitWebpage?: VisitWebpageConfig;
  gondolin?: GondolinConfig;
  memory?: MemoryConfig;
  skills?: SkillsConfig;
}

/**
 * Top-level agent runtime configuration.
 * Lives under `agent` in config.json.
 */
export interface SessionLimitsConfig {
  /** Max context length in tokens (input + cacheRead + cacheWrite) for any single turn. Default: 100000. */
  maxContextLength?: number;
  /** Max cumulative cost in USD across all turns. Default: 1.0. */
  maxCostUsd?: number;
}

/**
 * Convert a legacy maxIterations count to session limits.
 * Heuristic: ~10k context length and ~$0.04 cost per iteration.
 */
export function iterationsToSessionLimits(maxIterations?: number): SessionLimitsConfig | undefined {
  if (maxIterations == null) return undefined;
  return {
    maxContextLength: maxIterations * 10_000,
    maxCostUsd: maxIterations * 0.04,
  };
}

export interface AgentConfig {
  sessionLimits?: SessionLimitsConfig;
  llmDebugMaxChars?: number;
  progress?: {
    thresholdSeconds?: number;
  };
  /** Model to retry with when the primary model issues a content refusal. Empty string disables refusal fallback. */
  refusalFallbackModel?: string;
  /** Configuration for the agent's built-in tools. */
  tools?: ToolsConfig;
}

export interface EventsConfig {
  /** Heartbeat check interval in minutes. 0 disables. */
  heartbeatIntervalMinutes: number;
  /** Minimum period between periodic event fires in minutes. */
  minPeriodMinutes: number;
}

export interface CostPolicyConfig {
  freeTierBudgetUsd?: number;
  freeTierWindowHours?: number;
}

interface ChroniclerConfig {
  model?: string;
  paragraphsPerChapter?: number;
  arcModels?: Record<string, string>;
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
  promptReminder?: string;
  memoryUpdate?: boolean;
  toolSummary?: boolean;
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
  /**
   * Context reducer: condenses conversation history before feeding to the agent.
   * Both `model` and `prompt` must be set to enable reduction.
   */
  contextReducer?: { model?: string; prompt?: string };
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
  /** Allowlist of trusted user identifiers. When set, messages from users not on the list are marked untrusted. Format depends on room type: IRC uses hostmask glob patterns, Discord/Slack use normalizeName(displayName)_platformId. */
  userAllowlist?: string[];
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
  agent?: AgentConfig;
  chronicler?: ChroniclerConfig;
  costPolicy?: CostPolicyConfig;
  events?: Partial<EventsConfig>;
  rooms?: Record<string, RoomConfig>;
}

/** Recursively makes all properties optional. */
type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

// ── Deep merge with room-specific semantics ────────────────────────────

/**
 * Deep-merges two room config objects with room-specific semantics:
 * - `ignoreUsers` arrays are concatenated (not replaced) at any nesting depth
 * - `promptVars` string values are concatenated (not replaced) at any nesting depth
 *
 * Built on the generic `deepMerge` with per-key hooks for the special cases.
 */
export function mergeRoomConfigs(
  base: DeepPartial<RoomConfig>,
  override: DeepPartial<RoomConfig>,
): RoomConfig {
  return deepMerge(
    base as Record<string, unknown>,
    override as Record<string, unknown>,
    roomMergeHook,
  ) as RoomConfig;
}

function roomMergeHook(key: string, baseVal: unknown, overrideVal: unknown): unknown | undefined {
  if ((key === "ignoreUsers" || key === "userAllowlist") && Array.isArray(baseVal) && Array.isArray(overrideVal)) {
    return [...baseVal, ...overrideVal];
  }

  if (key === "promptVars" && isRecord(baseVal) && isRecord(overrideVal)) {
    const merged: Record<string, unknown> = { ...baseVal };
    for (const [varKey, varValue] of Object.entries(overrideVal)) {
      if (typeof merged[varKey] === "string" && typeof varValue === "string") {
        merged[varKey] = `${merged[varKey]}${varValue}`;
      } else {
        merged[varKey] = varValue;
      }
    }
    return merged;
  }

  return undefined;
}

// ── MuaddibConfig ──────────────────────────────────────────────────────

export class MuaddibConfig {
  private readonly data: MuaddibSettings;

  private constructor(data: MuaddibSettings) {
    this.data = data;
  }

  static load(path: string): MuaddibConfig {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return new MuaddibConfig(raw as MuaddibSettings);
  }

  static inMemory(overrides?: Record<string, unknown>): MuaddibConfig {
    return new MuaddibConfig((overrides ?? {}) as MuaddibSettings);
  }

  toObject(): Record<string, unknown> {
    return this.data as unknown as Record<string, unknown>;
  }

  /**
   * Returns the agent runtime config, with artifact path resolved relative
   * to `$MUADDIB_HOME/artifacts` if a relative path is given.
   */
  getAgentConfig(): AgentConfig {
    const a = this.data.agent ?? {};
    const tools = a.tools ?? {};
    const artifactsPathRaw = tools.artifacts?.path;
    const resolvedArtifactsPath = artifactsPathRaw
      ? resolveMuaddibPath(artifactsPathRaw, join(getMuaddibHome(), "artifacts"))
      : undefined;

    return {
      ...a,
      tools: {
        ...tools,
        artifacts: {
          ...tools.artifacts,
          path: resolvedArtifactsPath,
        },
      },
    };
  }

  getEventsConfig(): EventsConfig {
    const raw = this.data.events ?? {};
    return {
      heartbeatIntervalMinutes: raw.heartbeatIntervalMinutes ?? 60,
      minPeriodMinutes: raw.minPeriodMinutes ?? 30,
    };
  }

  getChroniclerConfig(): ChroniclerConfig {
    return this.data.chronicler ?? {};
  }

  getCostPolicyConfig(): CostPolicyConfig | undefined {
    return this.data.costPolicy;
  }

  getRoomConfig(roomName: string): RoomConfig {
    const rooms = this.data.rooms ?? {};
    const common = rooms.common ?? {};
    const room = rooms[roomName] ?? {};
    return mergeRoomConfigs(common, room);
  }
}
