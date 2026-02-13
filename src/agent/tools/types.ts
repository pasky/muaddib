import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Model, SimpleStreamOptions, UserMessage } from "@mariozechner/pi-ai";

import type { ChronicleStore } from "../../chronicle/chronicle-store.js";
import type { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import type { SessionFactoryContextMessage } from "../../agent/session-factory.js";

export interface ExecuteCodeInput {
  code: string;
  language?: "python" | "bash";
  input_artifacts?: string[];
  output_files?: string[];
}

export interface EditArtifactInput {
  artifact_url: string;
  old_string: string;
  new_string: string;
}

export interface OracleInput {
  query: string;
}

export interface GenerateImageInput {
  prompt: string;
  image_urls?: string[];
}

export interface ChronicleReadInput {
  relative_chapter_id: number;
}

export interface ChronicleAppendInput {
  text: string;
}

export interface QuestStartInput {
  id: string;
  goal: string;
  success_criteria: string;
}

export interface SubquestStartInput {
  id: string;
  goal: string;
  success_criteria: string;
}

export interface QuestSnoozeInput {
  until: string;
}

export interface GeneratedImageResultItem {
  data: string;
  mimeType: string;
  artifactUrl: string;
}

export interface GenerateImageResult {
  summaryText: string;
  images: GeneratedImageResultItem[];
}

export interface VisitWebpageImageResult {
  kind: "image";
  data: string;
  mimeType: string;
}

export type VisitWebpageResult = string | VisitWebpageImageResult;

export type CompleteSimpleFn = (
  model: Model<any>,
  context: { messages: UserMessage[]; systemPrompt?: string },
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface BaselineToolExecutors {
  webSearch: (query: string) => Promise<string>;
  visitWebpage: (url: string) => Promise<VisitWebpageResult>;
  executeCode: (input: ExecuteCodeInput) => Promise<string>;
  shareArtifact: (content: string) => Promise<string>;
  editArtifact: (input: EditArtifactInput) => Promise<string>;
  oracle: (input: OracleInput) => Promise<string>;
  generateImage: (input: GenerateImageInput) => Promise<GenerateImageResult>;
  chronicleRead: (input: ChronicleReadInput) => Promise<string>;
  chronicleAppend: (input: ChronicleAppendInput) => Promise<string>;
  questStart: (input: QuestStartInput) => Promise<string>;
  subquestStart: (input: SubquestStartInput) => Promise<string>;
  questSnooze: (input: QuestSnoozeInput) => Promise<string>;
}

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
  oracleAgentTools?: AgentTool<any>[];
  oracleConversationContext?: SessionFactoryContextMessage[];
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
