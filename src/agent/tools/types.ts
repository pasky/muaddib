import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ChronicleStore } from "../../chronicle/chronicle-store.js";
import type { ToolsConfig, ProvidersConfig } from "../../config/muaddib-config.js";
import type { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";

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

export interface ToolExecutorLogger {
  info(...data: unknown[]): void;
}

export interface DefaultToolExecutorOptions {
  /** Tools configuration — each tool executor resolves its own config from here. */
  toolsConfig?: ToolsConfig;
  /** Provider configuration (base URLs, etc.). */
  providersConfig?: ProvidersConfig;

  fetchImpl?: typeof fetch;
  secrets?: Record<string, unknown>;
  logger?: ToolExecutorLogger;
  maxWebContentLength?: number;
  maxImageBytes?: number;
  executeCodeTimeoutMs?: number;
  executeCodeWorkingDirectory?: string;
  /** Arc identifier for Sprites sandbox isolation (one sprite per arc). */
  spritesArc?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  modelAdapter?: PiAiModelAdapter;
  completeSimpleFn?: CompleteSimpleFn;
  oracleMaxIterations?: number;
  imageGenTimeoutMs?: number;
  chronicleStore?: ChronicleStore;
  chronicleLifecycle?: {
    appendParagraph: (arc: string, text: string) => Promise<unknown>;
  };
  chronicleArc?: string;
  currentQuestId?: string | null;
}

export type CompleteSimpleFn = (
  model: import("@mariozechner/pi-ai").Model<any>,
  context: { messages: import("@mariozechner/pi-ai").UserMessage[]; systemPrompt?: string },
  options?: import("@mariozechner/pi-ai").SimpleStreamOptions,
) => Promise<import("@mariozechner/pi-ai").AssistantMessage>;
