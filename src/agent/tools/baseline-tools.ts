import { createMakePlanTool, createProgressReportTool } from "./control.js";
import {
  createChronicleAppendTool,
  createChronicleReadTool,
  createDefaultChronicleAppendExecutor,
  createDefaultChronicleReadExecutor,
} from "./chronicle.js";
import {
  createDefaultExecuteCodeExecutor,
  createExecuteCodeTool,
} from "./execute-code.js";
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
  createDefaultQuestSnoozeExecutor,
  createDefaultQuestStartExecutor,
  createDefaultSubquestStartExecutor,
  createQuestSnoozeTool,
  createQuestStartTool,
  createSubquestStartTool,
} from "./quest.js";
import {
  createDefaultVisitWebpageExecutor,
  createDefaultWebSearchExecutor,
  createVisitWebpageTool,
  createWebSearchTool,
} from "./web.js";
import {
  createDefaultEditArtifactExecutor,
  createDefaultShareArtifactExecutor,
  createEditArtifactTool,
  createShareArtifactTool,
} from "./artifact.js";
import type { ShareArtifactExecutor, EditArtifactExecutor } from "./artifact.js";
import type { ChronicleReadExecutor, ChronicleAppendExecutor } from "./chronicle.js";
import type { ExecuteCodeExecutor } from "./execute-code.js";
import type { GenerateImageExecutor } from "./image.js";
import type { OracleExecutor } from "./oracle.js";
import type { QuestStartExecutor, SubquestStartExecutor, QuestSnoozeExecutor } from "./quest.js";
import type { WebSearchExecutor, VisitWebpageExecutor } from "./web.js";
import type { ToolContext, MuaddibTool, ToolPersistType } from "./types.js";

export interface BaselineToolExecutors {
  webSearch: WebSearchExecutor;
  visitWebpage: VisitWebpageExecutor;
  executeCode: ExecuteCodeExecutor;
  shareArtifact: ShareArtifactExecutor;
  editArtifact: EditArtifactExecutor;
  oracle: OracleExecutor;
  generateImage: GenerateImageExecutor;
  chronicleRead: ChronicleReadExecutor;
  chronicleAppend: ChronicleAppendExecutor;
  questStart: QuestStartExecutor;
  subquestStart: SubquestStartExecutor;
  questSnooze: QuestSnoozeExecutor;
}

export type { ToolContext, MuaddibTool, ToolPersistType };
export type { EditArtifactInput, ShareArtifactExecutor, EditArtifactExecutor } from "./artifact.js";
export type { ChronicleReadInput, ChronicleAppendInput, ChronicleReadExecutor, ChronicleAppendExecutor } from "./chronicle.js";
export type { ExecuteCodeInput, ExecuteCodeExecutor } from "./execute-code.js";
export type { GenerateImageInput, GenerateImageResult, GeneratedImageResultItem, GenerateImageExecutor } from "./image.js";
export type { OracleInput, OracleExecutor } from "./oracle.js";
export type { QuestStartInput, SubquestStartInput, QuestSnoozeInput, QuestStartExecutor, SubquestStartExecutor, QuestSnoozeExecutor } from "./quest.js";
export type { VisitWebpageImageResult, VisitWebpageResult, WebSearchExecutor, VisitWebpageExecutor } from "./web.js";

export {
  createChronicleAppendTool,
  createChronicleReadTool,
  createEditArtifactTool,
  createExecuteCodeTool,
  createGenerateImageTool,
  createMakePlanTool,
  createOracleTool,
  createProgressReportTool,
  createQuestSnoozeTool,
  createQuestStartTool,
  createShareArtifactTool,
  createSubquestStartTool,
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
}

type ExecutorBackedToolFactory = (executors: BaselineToolExecutors) => MuaddibTool;

/**
 * Select quest tools based on active quest context, matching Python parity:
 * - No active quest → quest_start only
 * - Top-level quest (no dots) → subquest_start + quest_snooze
 * - Sub-quest (has dots) → quest_snooze only
 */
function getQuestToolGroup(currentQuestId?: string | null): ReadonlyArray<ExecutorBackedToolFactory> {
  if (!currentQuestId) {
    return [createQuestStartTool];
  }
  if (!currentQuestId.includes(".")) {
    return [createSubquestStartTool, createQuestSnoozeTool];
  }
  return [createQuestSnoozeTool];
}

const BASELINE_TOOL_FACTORIES: ReadonlyArray<ExecutorBackedToolFactory> = [
  createWebSearchTool,
  createVisitWebpageTool,
  createExecuteCodeTool,
  createShareArtifactTool,
  createEditArtifactTool,
  createGenerateImageTool,
  createOracleTool,
  createChronicleReadTool,
  createChronicleAppendTool,
];

export function createDefaultToolExecutors(
  options: ToolContext,
  oracleInvocation?: OracleInvocationContext,
): BaselineToolExecutors {
  return {
    webSearch: createDefaultWebSearchExecutor(options),
    visitWebpage: createDefaultVisitWebpageExecutor(options),
    executeCode: createDefaultExecuteCodeExecutor(options),
    shareArtifact: createDefaultShareArtifactExecutor(options),
    editArtifact: createDefaultEditArtifactExecutor(options),
    generateImage: createDefaultGenerateImageExecutor(options),
    oracle: createDefaultOracleExecutor(options, oracleInvocation),
    chronicleRead: createDefaultChronicleReadExecutor(options),
    chronicleAppend: createDefaultChronicleAppendExecutor(options),
    questStart: createDefaultQuestStartExecutor(options),
    subquestStart: createDefaultSubquestStartExecutor(options),
    questSnooze: createDefaultQuestSnoozeExecutor(options),
  };
}

/**
 * Baseline tool set for command-path parity.
 * Grouped by tool domains (web, execution, artifacts, images, oracle, chronicle, quests).
 */
export function createBaselineAgentTools(options: BaselineToolOptions): MuaddibTool[] {
  const defaultExecutors = createDefaultToolExecutors(options, options.oracleInvocation);
  const overrides = options.executors ?? {};
  const executors: BaselineToolExecutors = {
    ...defaultExecutors,
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  } as BaselineToolExecutors;

  const questToolGroup = getQuestToolGroup(options.currentQuestId);

  const executorBackedTools = [...BASELINE_TOOL_FACTORIES, ...questToolGroup].map((factory) =>
    factory(executors),
  );

  return [
    ...executorBackedTools,
    createProgressReportTool(options),
    createMakePlanTool({
      chronicleStore: options.chronicleStore,
      currentQuestId: options.currentQuestId,
    }),
  ];
}
