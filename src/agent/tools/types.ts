import type { ChronicleStore } from "../../chronicle/chronicle-store.js";
import type { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";

export interface ToolExecutorLogger {
  info(...data: unknown[]): void;
}

export interface DefaultToolExecutorOptions {
  fetchImpl?: typeof fetch;
  jinaApiKey?: string;
  secrets?: Record<string, unknown>;
  logger?: ToolExecutorLogger;
  maxWebContentLength?: number;
  maxImageBytes?: number;
  executeCodeTimeoutMs?: number;
  executeCodeWorkingDirectory?: string;
  artifactsPath?: string;
  artifactsUrl?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  modelAdapter?: PiAiModelAdapter;
  completeSimpleFn?: CompleteSimpleFn;
  oracleModel?: string;
  oraclePrompt?: string;
  oracleMaxIterations?: number;
  imageGenModel?: string;
  openRouterBaseUrl?: string;
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
