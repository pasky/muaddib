import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { ChronicleStore } from "../../chronicle/chronicle-store.js";
import type { ToolsConfig, ProvidersConfig } from "../../config/muaddib-config.js";
import type { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import type { Logger } from "../../app/logging.js";

/** How a tool's I/O is persisted for future context recall. */
export type ToolPersistType = "none" | "summary" | "artifact";

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
 * Shared context passed to tool executor factories.
 *
 * Each tool executor picks the fields it needs — no tool uses all of them.
 */
export interface ToolContext {
  // ── Config (tools resolve their own settings from these) ──
  toolsConfig?: ToolsConfig;
  providersConfig?: ProvidersConfig;

  // ── Runtime services ──
  authStorage: AuthStorage;
  modelAdapter: PiAiModelAdapter;
  logger?: Logger;
  chronicleStore?: ChronicleStore;
  chronicleLifecycle?: {
    appendParagraph: (arc: string, text: string) => Promise<unknown>;
  };

  // ── Per-invocation context ──
  /** Arc identifier (e.g. "libera##test"), used for Sprites isolation and chronicle scoping. */
  arc?: string;
  currentQuestId?: string | null;
  /** HTTP header secrets for authenticated web requests. */
  secrets?: Record<string, unknown>;
}
