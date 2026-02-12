import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import {
  createDefaultToolExecutors,
  type BaselineToolExecutors,
  type DefaultToolExecutorOptions,
  type EditArtifactInput,
  type ExecuteCodeInput,
  type ChronicleAppendInput,
  type ChronicleReadInput,
  type GenerateImageInput,
  type OracleInput,
  type QuestSnoozeInput,
  type QuestStartInput,
  type SubquestStartInput,
  type VisitWebpageResult,
} from "./core-executors.js";

export interface BaselineToolOptions extends DefaultToolExecutorOptions {
  onProgressReport?: (text: string) => void | Promise<void>;
  executors?: Partial<BaselineToolExecutors>;
}

/**
 * Baseline tool set for command-path parity.
 * Expanded with core workflow tools first: web_search, visit_webpage, execute_code,
 * advanced artifact/media helpers, and chronicler/quest tool-surface parity.
 */
export function createBaselineAgentTools(options: BaselineToolOptions = {}): AgentTool<any>[] {
  const defaultExecutors = createDefaultToolExecutors(options);
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

  return [
    createWebSearchTool(executors),
    createVisitWebpageTool(executors),
    createExecuteCodeTool(executors),
    createShareArtifactTool(executors),
    createEditArtifactTool(executors),
    createGenerateImageTool(executors),
    createOracleTool(executors),
    createChronicleReadTool(executors),
    createChronicleAppendTool(executors),
    createQuestStartTool(executors),
    createSubquestStartTool(executors),
    createQuestSnoozeTool(executors),
    createProgressReportTool(options),
    createMakePlanTool(),
    createFinalAnswerTool(),
  ];
}

export function createWebSearchTool(executors: Pick<BaselineToolExecutors, "webSearch">): AgentTool<any> {
  return {
    name: "web_search",
    label: "Web Search",
    description: "Search the web and return top results with titles, URLs, and descriptions.",
    parameters: Type.Object({
      query: Type.String({
        description: "The search query to perform.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const output = await executors.webSearch(params.query);
      return {
        content: [{ type: "text", text: output }],
        details: {
          query: params.query,
        },
      };
    },
  };
}

export function createVisitWebpageTool(
  executors: Pick<BaselineToolExecutors, "visitWebpage">,
): AgentTool<any> {
  return {
    name: "visit_webpage",
    label: "Visit Webpage",
    description:
      "Visit the given URL and return content as markdown text, or as image content for image URLs.",
    parameters: Type.Object({
      url: Type.String({
        format: "uri",
        description: "The URL to visit.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const output = await executors.visitWebpage(params.url);
      return toolResultFromVisitWebpageOutput(params.url, output);
    },
  };
}

export function createExecuteCodeTool(executors: Pick<BaselineToolExecutors, "executeCode">): AgentTool<any> {
  return {
    name: "execute_code",
    label: "Execute Code",
    description:
      "Execute code and return output. Supports python and bash. Input/output artifact features are incremental in TS.",
    parameters: Type.Object({
      code: Type.String({
        description: "The code to execute.",
      }),
      language: Type.Optional(
        Type.Union([Type.Literal("python"), Type.Literal("bash")], {
          description: "The language to execute in (python or bash).",
          default: "python",
        }),
      ),
      input_artifacts: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional list of artifact URLs to preload.",
        }),
      ),
      output_files: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional list of output files to export.",
        }),
      ),
    }),
    execute: async (_toolCallId, params: ExecuteCodeInput) => {
      const output = await executors.executeCode(params);
      return {
        content: [{ type: "text", text: output }],
        details: {
          language: params.language ?? "python",
        },
      };
    },
  };
}

export function createShareArtifactTool(
  executors: Pick<BaselineToolExecutors, "shareArtifact">,
): AgentTool<any> {
  return {
    name: "share_artifact",
    label: "Share Artifact",
    description:
      "Share additional content as an artifact and return a public URL. Use for scripts, reports, or large outputs.",
    parameters: Type.Object({
      content: Type.String({
        description: "The text content to publish as an artifact.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const output = await executors.shareArtifact(params.content);
      return {
        content: [{ type: "text", text: output }],
        details: {
          kind: "share_artifact",
        },
      };
    },
  };
}

export function createEditArtifactTool(executors: Pick<BaselineToolExecutors, "editArtifact">): AgentTool<any> {
  return {
    name: "edit_artifact",
    label: "Edit Artifact",
    description:
      "Edit an existing artifact by replacing a unique old_string with new_string and return a new artifact URL.",
    parameters: Type.Object({
      artifact_url: Type.String({
        format: "uri",
        description: "Artifact URL to edit.",
      }),
      old_string: Type.String({
        description: "Exact text to replace; must match uniquely.",
      }),
      new_string: Type.String({
        description: "Replacement text (can be empty).",
      }),
    }),
    execute: async (_toolCallId, params: EditArtifactInput) => {
      const output = await executors.editArtifact(params);
      return {
        content: [{ type: "text", text: output }],
        details: {
          artifactUrl: params.artifact_url,
          kind: "edit_artifact",
        },
      };
    },
  };
}

export function createGenerateImageTool(
  executors: Pick<BaselineToolExecutors, "generateImage">,
): AgentTool<any> {
  return {
    name: "generate_image",
    label: "Generate Image",
    description:
      "Generate image(s) using tools.image_gen.model. Optionally include reference image URLs for edits or variations.",
    parameters: Type.Object({
      prompt: Type.String({
        description: "Text description of the image to generate.",
      }),
      image_urls: Type.Optional(
        Type.Array(Type.String({ format: "uri" }), {
          description: "Optional list of reference image URLs to include.",
        }),
      ),
    }),
    execute: async (_toolCallId, params: GenerateImageInput) => {
      const output = await executors.generateImage(params);
      return {
        content: [
          { type: "text", text: output.summaryText },
          ...output.images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
        details: {
          kind: "generate_image",
          count: output.images.length,
          artifactUrls: output.images.map((image) => image.artifactUrl),
        },
      };
    },
  };
}

export function createOracleTool(executors: Pick<BaselineToolExecutors, "oracle">): AgentTool<any> {
  return {
    name: "oracle",
    label: "Oracle",
    description:
      "Consult the oracle model for deeper analysis or creative problem-solving guidance.",
    parameters: Type.Object({
      query: Type.String({
        description: "The question or task for the oracle.",
      }),
    }),
    execute: async (_toolCallId, params: OracleInput) => {
      const output = await executors.oracle(params);
      return {
        content: [{ type: "text", text: output }],
        details: {
          kind: "oracle",
          query: params.query,
        },
      };
    },
  };
}

export function createChronicleReadTool(
  executors: Pick<BaselineToolExecutors, "chronicleRead">,
): AgentTool<any> {
  return {
    name: "chronicle_read",
    label: "Chronicle Read",
    description:
      "Read from a relative chapter in the Chronicle (0=current, -1=previous chapter, etc.).",
    parameters: Type.Object({
      relative_chapter_id: Type.Integer({
        description:
          "Relative chapter offset from current chapter. Use -1 for previous chapter, -2 for two chapters back.",
      }),
    }),
    execute: async (_toolCallId, params: ChronicleReadInput) => {
      const output = await executors.chronicleRead(params);
      return {
        content: [{ type: "text", text: output }],
        details: {
          kind: "chronicle_read",
          relativeChapterId: params.relative_chapter_id,
        },
      };
    },
  };
}

export function createChronicleAppendTool(
  executors: Pick<BaselineToolExecutors, "chronicleAppend">,
): AgentTool<any> {
  return {
    name: "chronicle_append",
    label: "Chronicle Append",
    description:
      "Append a concise paragraph to the current Chronicle chapter for future recall.",
    parameters: Type.Object({
      text: Type.String({
        description: "Paragraph text to append.",
      }),
    }),
    execute: async (_toolCallId, params: ChronicleAppendInput) => {
      const output = await executors.chronicleAppend(params);
      return {
        content: [{ type: "text", text: output }],
        details: {
          kind: "chronicle_append",
        },
      };
    },
  };
}

export function createQuestStartTool(
  executors: Pick<BaselineToolExecutors, "questStart">,
): AgentTool<any> {
  return {
    name: "quest_start",
    label: "Quest Start",
    description:
      "Start a top-level quest. Only use when a user explicitly asks for a multi-step autonomous task.",
    parameters: Type.Object({
      id: Type.String({
        description: "Quest identifier (letters, numbers, hyphens, underscores).",
      }),
      goal: Type.String({
        description: "What the quest should accomplish.",
      }),
      success_criteria: Type.String({
        description: "Specific criteria for quest completion.",
      }),
    }),
    execute: async (_toolCallId, params: QuestStartInput) => {
      const output = await executors.questStart(params);
      return {
        content: [{ type: "text", text: output }],
        details: {
          kind: "quest_start",
          questId: params.id,
        },
      };
    },
  };
}

export function createSubquestStartTool(
  executors: Pick<BaselineToolExecutors, "subquestStart">,
): AgentTool<any> {
  return {
    name: "subquest_start",
    label: "Subquest Start",
    description: "Start a subquest for the active quest context.",
    parameters: Type.Object({
      id: Type.String({
        description: "Subquest identifier.",
      }),
      goal: Type.String({
        description: "What the subquest should accomplish.",
      }),
      success_criteria: Type.String({
        description: "Specific criteria for subquest completion.",
      }),
    }),
    execute: async (_toolCallId, params: SubquestStartInput) => {
      const output = await executors.subquestStart(params);
      return {
        content: [{ type: "text", text: output }],
        details: {
          kind: "subquest_start",
          subquestId: params.id,
        },
      };
    },
  };
}

export function createQuestSnoozeTool(
  executors: Pick<BaselineToolExecutors, "questSnooze">,
): AgentTool<any> {
  return {
    name: "quest_snooze",
    label: "Quest Snooze",
    description: "Snooze the active quest until HH:MM local time.",
    parameters: Type.Object({
      until: Type.String({
        description: "Resume time in HH:MM (24-hour) format.",
      }),
    }),
    execute: async (_toolCallId, params: QuestSnoozeInput) => {
      const output = await executors.questSnooze(params);
      return {
        content: [{ type: "text", text: output }],
        details: {
          kind: "quest_snooze",
          until: params.until,
        },
      };
    },
  };
}

export function createProgressReportTool(options: BaselineToolOptions = {}): AgentTool<any> {
  return {
    name: "progress_report",
    label: "Progress Report",
    description: "Send a short progress update while working on a response.",
    parameters: Type.Object({
      text: Type.String({
        description: "One-line progress update.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      if (options.onProgressReport) {
        await options.onProgressReport(params.text);
      }

      return {
        content: [{ type: "text", text: params.text }],
        details: {
          reported: params.text,
        },
      };
    },
  };
}

export function createMakePlanTool(): AgentTool<any> {
  return {
    name: "make_plan",
    label: "Make Plan",
    description: "Capture a brief plan before continuing with work.",
    parameters: Type.Object({
      plan: Type.String({
        description: "Plan summary.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      return {
        content: [{ type: "text", text: params.plan }],
        details: {
          plan: params.plan,
        },
      };
    },
  };
}

export function createFinalAnswerTool(): AgentTool<any> {
  return {
    name: "final_answer",
    label: "Final Answer",
    description: "Provide the final user-facing answer.",
    parameters: Type.Object({
      answer: Type.String({
        description: "Final answer text.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      return {
        content: [{ type: "text", text: params.answer }],
        details: {
          answer: params.answer,
        },
      };
    },
  };
}

function toolResultFromVisitWebpageOutput(url: string, output: VisitWebpageResult) {
  if (typeof output === "string") {
    return {
      content: [{ type: "text" as const, text: output }],
      details: { url, kind: "text" as const },
    };
  }

  return {
    content: [
      {
        type: "image" as const,
        data: output.data,
        mimeType: output.mimeType,
      },
    ],
    details: { url, kind: output.kind, mimeType: output.mimeType },
  };
}
