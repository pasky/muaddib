import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

export interface BaselineToolOptions {
  onProgressReport?: (text: string) => void | Promise<void>;
}

/**
 * Baseline tool set for command-path parity.
 * Intentionally small for Milestone 4: enough to support planning/finalization patterns.
 */
export function createBaselineAgentTools(options: BaselineToolOptions = {}): AgentTool<any>[] {
  return [
    createProgressReportTool(options),
    createMakePlanTool(),
    createFinalAnswerTool(),
  ];
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
