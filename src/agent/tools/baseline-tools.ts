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
import type { EditArtifactInput, ShareArtifactExecutor, EditArtifactExecutor } from "./artifact.js";
import type { ChronicleReadInput, ChronicleAppendInput, ChronicleReadExecutor, ChronicleAppendExecutor } from "./chronicle.js";
import type { ExecuteCodeInput, ExecuteCodeExecutor } from "./execute-code.js";
import type { GenerateImageInput, GenerateImageResult, GeneratedImageResultItem, GenerateImageExecutor } from "./image.js";
import type { OracleInput, OracleExecutor } from "./oracle.js";
import type { QuestStartInput, SubquestStartInput, QuestSnoozeInput, QuestStartExecutor, SubquestStartExecutor, QuestSnoozeExecutor } from "./quest.js";
import type { VisitWebpageImageResult, VisitWebpageResult, WebSearchExecutor, VisitWebpageExecutor } from "./web.js";
import type { DefaultToolExecutorOptions, MuaddibTool, ToolPersistType } from "./types.js";

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

export type { DefaultToolExecutorOptions, MuaddibTool, ToolPersistType };
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

export interface BaselineToolOptions extends DefaultToolExecutorOptions {
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

const WEB_TOOL_GROUP: ReadonlyArray<ExecutorBackedToolFactory> = [
  createWebSearchTool,
  createVisitWebpageTool,
];

const EXECUTE_CODE_TOOL_GROUP: ReadonlyArray<ExecutorBackedToolFactory> = [
  createExecuteCodeTool,
];

const ARTIFACT_TOOL_GROUP: ReadonlyArray<ExecutorBackedToolFactory> = [
  createShareArtifactTool,
  createEditArtifactTool,
];

const IMAGE_TOOL_GROUP: ReadonlyArray<ExecutorBackedToolFactory> = [
  createGenerateImageTool,
];

const ORACLE_TOOL_GROUP: ReadonlyArray<ExecutorBackedToolFactory> = [
  createOracleTool,
];

const CHRONICLE_TOOL_GROUP: ReadonlyArray<ExecutorBackedToolFactory> = [
  createChronicleReadTool,
  createChronicleAppendTool,
];

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

const BASELINE_EXECUTOR_TOOL_GROUPS: ReadonlyArray<ReadonlyArray<ExecutorBackedToolFactory>> = [
  WEB_TOOL_GROUP,
  EXECUTE_CODE_TOOL_GROUP,
  ARTIFACT_TOOL_GROUP,
  IMAGE_TOOL_GROUP,
  ORACLE_TOOL_GROUP,
  CHRONICLE_TOOL_GROUP,
];

export function createDefaultToolExecutors(
  options: DefaultToolExecutorOptions = {},
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
export function createBaselineAgentTools(options: BaselineToolOptions = {}): MuaddibTool[] {
  const defaultExecutors = createDefaultToolExecutors(options, options.oracleInvocation);
  const executors: BaselineToolExecutors = {
    webSearch: options.executors?.webSearch ?? defaultExecutors.webSearch,
    visitWebpage: options.executors?.visitWebpage ?? defaultExecutors.visitWebpage,
    executeCode: options.executors?.executeCode ?? defaultExecutors.executeCode,
    shareArtifact: options.executors?.shareArtifact ?? defaultExecutors.shareArtifact,
    editArtifact: options.executors?.editArtifact ?? defaultExecutors.editArtifact,
    generateImage: options.executors?.generateImage ?? defaultExecutors.generateImage,
    oracle: options.executors?.oracle ?? defaultExecutors.oracle,
    chronicleRead: options.executors?.chronicleRead ?? defaultExecutors.chronicleRead,
    chronicleAppend: options.executors?.chronicleAppend ?? defaultExecutors.chronicleAppend,
    questStart: options.executors?.questStart ?? defaultExecutors.questStart,
    subquestStart: options.executors?.subquestStart ?? defaultExecutors.subquestStart,
    questSnooze: options.executors?.questSnooze ?? defaultExecutors.questSnooze,
  };

  const questToolGroup = getQuestToolGroup(options.currentQuestId);

  const executorBackedTools = [...BASELINE_EXECUTOR_TOOL_GROUPS, questToolGroup].flatMap((group) =>
    group.map((factory) => factory(executors)),
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
