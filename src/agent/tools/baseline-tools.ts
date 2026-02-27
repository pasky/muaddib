import { toConfiguredString } from "../../utils/index.js";
import { createMakePlanTool, createProgressReportTool } from "./control.js";
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
  createDefaultVisitWebpageExecutor,
  createDefaultWebSearchExecutor,
  createVisitWebpageTool,
  createWebSearchTool,
} from "./web.js";
import { createGondolinTools } from "./gondolin-tools.js";
import type { ArcEventsWatcher } from "../../events/watcher.js";
import type { GenerateImageExecutor } from "./image.js";
import type { OracleExecutor } from "./oracle.js";
import type { WebSearchExecutor, VisitWebpageExecutor } from "./web.js";
import type { ToolContext, MuaddibTool, ToolPersistType, ToolSet } from "./types.js";

export interface BaselineToolExecutors {
  webSearch: WebSearchExecutor;
  visitWebpage: VisitWebpageExecutor;
  oracle: OracleExecutor;
  generateImage: GenerateImageExecutor;
}

export type { ToolContext, MuaddibTool, ToolPersistType, ToolSet };
export type { ShareArtifactInput, ShareArtifactExecutor } from "./artifact.js";
export type { GenerateImageInput, GenerateImageResult, GeneratedImageResultItem, GenerateImageExecutor } from "./image.js";
export type { OracleInput, OracleExecutor } from "./oracle.js";
export type { VisitWebpageImageResult, VisitWebpageResult, WebSearchExecutor, VisitWebpageExecutor } from "./web.js";

export {
  createGenerateImageTool,
  createMakePlanTool,
  createOracleTool,
  createProgressReportTool,
  createVisitWebpageTool,
  createWebSearchTool,
  ORACLE_EXCLUDED_TOOLS,
};

export interface BaselineToolOptions extends ToolContext {
  onProgressReport?: (text: string) => void | Promise<void>;
  executors?: Partial<BaselineToolExecutors>;

  /**
   * Per-invocation oracle context (conversation context, tool factory).
   * When set, the oracle executor gets a nested agentic loop with tools.
   * When absent (e.g. inside the oracle's own nested loop), the oracle
   * falls back to a simple toolless completion.
   */
  oracleInvocation?: OracleInvocationContext;

  /** Arc events watcher for Gondolin /events/ mount notifications. */
  eventsWatcher?: ArcEventsWatcher;
}

type ExecutorBackedToolFactory = (executors: BaselineToolExecutors, options: BaselineToolOptions) => MuaddibTool;

const BASELINE_TOOL_FACTORIES: ReadonlyArray<ExecutorBackedToolFactory> = [
  createWebSearchTool,
  createVisitWebpageTool,
  (executors, options) => createGenerateImageTool(executors, toConfiguredString(options.toolsConfig?.imageGen?.model)),
  (executors, options) => createOracleTool(executors, toConfiguredString(options.toolsConfig?.oracle?.model)),
];

export function createDefaultToolExecutors(
  options: ToolContext,
  oracleInvocation?: OracleInvocationContext,
): BaselineToolExecutors {
  return {
    webSearch: createDefaultWebSearchExecutor(options),
    visitWebpage: createDefaultVisitWebpageExecutor(options),
    generateImage: createDefaultGenerateImageExecutor(options),
    oracle: createDefaultOracleExecutor(options, oracleInvocation),
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

  const defaultExecutors = createDefaultToolExecutors(options, options.oracleInvocation);
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
    config: gondolinConfig,
    toolsConfig: options.toolsConfig,
    logger: options.logger,
    eventsWatcher: options.eventsWatcher,
  });

  const tools = [
    ...executorBackedTools,
    ...gondolinToolSet.tools,
    createProgressReportTool(options),
    createMakePlanTool(),
  ];

  return { tools, dispose: gondolinToolSet.dispose, systemPromptSuffix: gondolinToolSet.systemPromptSuffix };
}
