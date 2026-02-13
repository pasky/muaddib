import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

export interface ProgressReportToolOptions {
  onProgressReport?: (text: string) => void | Promise<void>;
}

export function createProgressReportTool(options: ProgressReportToolOptions = {}): AgentTool<any> {
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
