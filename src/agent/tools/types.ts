import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { ToolsConfig } from "../../config/muaddib-config.js";
import type { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import type { Logger } from "../../app/logging.js";

/** How a tool's I/O is persisted for future context recall. */
export type ToolPersistType = "none" | "summary" | "artifact";

/**
 * Tools returned by a tool-set factory, together with an optional cleanup
 * callback.  `dispose` is called by SessionRunner at the end of every
 * prompt() call (success or failure) to release session-scoped resources
 * such as Gondolin VM refcounts.
 *
 * `systemPromptSuffix` is appended to the system prompt by SessionRunner
 * when present — used to inject sandbox-specific context (e.g. directory layout).
 */
export interface ToolSet {
  tools: MuaddibTool[];
  dispose?: () => Promise<void>;
  systemPromptSuffix?: string;
}

/**
 * Extension of AgentTool with muaddib-specific metadata.
 * The `persistType` field controls how tool call results are summarised
 * and stored in the chronicle for future recall (matching the Python
 * tool `persist` field).
 */
export interface MuaddibTool<T = any> extends AgentTool<any, T> {
  persistType: ToolPersistType;
}

/**
 * Minimal context needed by artifact storage (writeArtifactText/writeArtifactBytes)
 * and artifact tool executors. Only requires the artifacts config and a logger.
 */
export interface ArtifactContext {
  toolsConfig?: Pick<ToolsConfig, "artifacts">;
  logger?: Logger;
}

/**
 * Shared context passed to tool executor factories.
 *
 * Each tool executor picks the fields it needs — no tool uses all of them.
 */
export interface ToolContext extends ArtifactContext {
  // ── Config (tools resolve their own settings from these) ──
  // Widens ArtifactContext's Pick<ToolsConfig, "artifacts"> to the full config.
  toolsConfig?: ToolsConfig;
  // ── Runtime services ──
  authStorage: AuthStorage;
  modelAdapter: PiAiModelAdapter;

  // ── Per-invocation context ──
  /** Arc identifier (e.g. "libera##test"), used for Gondolin VM isolation and chronicle scoping. */
  arc: string;
  /** HTTP header secrets for authenticated web requests. */
  secrets?: Record<string, unknown>;
}
