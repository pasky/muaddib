import { toConfiguredString } from "../../utils/index.js";
import { createMakePlanTool } from "./control.js";
import {
  createDefaultGenerateImageExecutor,
  createGenerateImageTool,
} from "./image.js";
import {
  createDefaultOracleExecutor,
  createOracleTool,
  ORACLE_EXCLUDED_TOOLS,
  type OracleInvocationContext,
} from "./oracle.js";
import {
  createDefaultDeepResearchExecutor,
  createDeepResearchTool,
  type DeepResearchInvocationContext,
} from "./deep-research.js";
import {
  createDefaultVisitWebpageExecutor,
  createDefaultWebSearchExecutor,
  createVisitWebpageTool,
  createWebSearchTool,
} from "./web.js";
import {
  createDefaultRequestNetworkAccessExecutor,
  createRequestNetworkAccessTool,
} from "./request-network-access.js";
import { createGondolinTools } from "./gondolin-tools.js";
import { createSessionQueryTool } from "./session-query.js";
import type { ArcEventsWatcher } from "../../events/watcher.js";
import type { GenerateImageExecutor } from "./image.js";
import type { OracleExecutor } from "./oracle.js";
import type { DeepResearchExecutor } from "./deep-research.js";
import type { WebSearchExecutor, VisitWebpageExecutor } from "./web.js";
import type { RequestNetworkAccessExecutor } from "./request-network-access.js";
import type { ToolContext, MuaddibTool, ToolPersistType, ToolSet } from "./types.js";

export interface BaselineToolExecutors {
  webSearch: WebSearchExecutor;
  visitWebpage: VisitWebpageExecutor;
  requestNetworkAccess: RequestNetworkAccessExecutor;
  oracle: OracleExecutor;
  deepResearch: DeepResearchExecutor;
  generateImage: GenerateImageExecutor;
}

export type { ToolContext, MuaddibTool, ToolPersistType, ToolSet };
export type { ShareArtifactInput, ShareArtifactExecutor } from "./artifact.js";
export type { GenerateImageInput, GenerateImageResult, GeneratedImageResultItem, GenerateImageExecutor } from "./image.js";
export type { OracleInput, OracleExecutor } from "./oracle.js";
export type { DeepResearchInput, DeepResearchExecutor } from "./deep-research.js";
export type { VisitWebpageImageResult, VisitWebpageResult, WebSearchExecutor, VisitWebpageExecutor } from "./web.js";
export type { RequestNetworkAccessInput, RequestNetworkAccessExecutor } from "./request-network-access.js";

export {
  createGenerateImageTool,
  createMakePlanTool,
  createOracleTool,
  createDeepResearchTool,
  createRequestNetworkAccessTool,
  createVisitWebpageTool,
  createWebSearchTool,
  ORACLE_EXCLUDED_TOOLS,
};

export interface BaselineToolOptions extends ToolContext {
  executors?: Partial<BaselineToolExecutors>;

  /**
   * Per-invocation oracle context (conversation context, tool factory).
   * When set, the oracle executor gets a nested agentic loop with tools.
   * When absent (e.g. inside the oracle's own nested loop), the oracle
   * falls back to a simple toolless completion.
   */
  oracleInvocation?: OracleInvocationContext;

  /**
   * Per-invocation deep research context (conversation context, thinking level).
   * When set, the deep research executor gets web-only tools and conversation context.
   */
  deepResearchInvocation?: DeepResearchInvocationContext;

  /** Arc events watcher for Gondolin /events/ mount notifications. */
  eventsWatcher?: ArcEventsWatcher;

  /** When true, omit MEMORY.md from the system prompt suffix (used by !c / noContext). */
  skipMemory?: boolean;

  /** Nick of the user who triggered this session (for per-user memory). */
  nick?: string;

  /** Thread identifier (e.g. Slack thread_ts) — auto-injected into events written to /events/. */
  threadId?: string;
}

type ExecutorBackedToolFactory = (executors: BaselineToolExecutors, options: BaselineToolOptions) => MuaddibTool;

const BASELINE_TOOL_FACTORIES: ReadonlyArray<ExecutorBackedToolFactory> = [
  createWebSearchTool,
  createVisitWebpageTool,
  createRequestNetworkAccessTool,
  (executors, options) => createGenerateImageTool(executors, toConfiguredString(options.toolsConfig?.imageGen?.model)),
  (executors, options) => createOracleTool(executors, toConfiguredString(options.toolsConfig?.oracle?.model)),
  (executors, options) => createDeepResearchTool(executors, toConfiguredString(options.toolsConfig?.deepResearch?.model)),
];

export function createDefaultToolExecutors(
  options: ToolContext,
  oracleInvocation?: OracleInvocationContext,
  deepResearchInvocation?: DeepResearchInvocationContext,
): BaselineToolExecutors {
  return {
    webSearch: createDefaultWebSearchExecutor(options),
    visitWebpage: createDefaultVisitWebpageExecutor(options),
    requestNetworkAccess: createDefaultRequestNetworkAccessExecutor(options),
    generateImage: createDefaultGenerateImageExecutor(options),
    oracle: createDefaultOracleExecutor(options, oracleInvocation),
    deepResearch: createDefaultDeepResearchExecutor(options, deepResearchInvocation),
  };
}

/**
 * Baseline tool set for command-path parity.
 * Grouped by tool domains (web, sandbox, artifacts, images, oracle).
 *
 * Gondolin read/write/edit/bash tools are always included, backed by a per-arc micro-VM.
 */
export function createBaselineAgentTools(options: BaselineToolOptions): ToolSet {
  const gondolinConfig = options.toolsConfig?.gondolin ?? {};

  const defaultExecutors = createDefaultToolExecutors(options, options.oracleInvocation, options.deepResearchInvocation);
  const overrides = options.executors ?? {};
  const executors: BaselineToolExecutors = {
    ...defaultExecutors,
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  } as BaselineToolExecutors;

  const executorBackedTools = BASELINE_TOOL_FACTORIES.map((factory) =>
    factory(executors, options),
  );

  const gondolinToolSet = createGondolinTools({
    arc: options.arc,
    serverTag: options.serverTag,
    channelName: options.channelName,
    config: gondolinConfig,
    authStorage: options.authStorage,
    toolsConfig: options.toolsConfig,
    logger: options.logger,
    eventsWatcher: options.eventsWatcher,
    skipMemory: options.skipMemory,
    nick: options.nick,
    threadId: options.threadId,
  });

  const tools = [
    ...executorBackedTools,
    ...gondolinToolSet.tools,
    createMakePlanTool(),
    createSessionQueryTool(options),
  ];

  return {
    tools,
    dispose: gondolinToolSet.dispose,
    systemPromptSuffix: gondolinToolSet.systemPromptSuffix,
    sessionHostDir: gondolinToolSet.sessionHostDir,
  };
}
