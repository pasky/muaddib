import { Type } from "@sinclair/typebox";
import type { ChronicleStore } from "../../chronicle/chronicle-store.js";
import type { MuaddibTool } from "./types.js";

interface ProgressReportToolOptions {
  onProgressReport?: (text: string) => void | Promise<void>;
  /** Minimum seconds between delivered reports (default 15). */
  minIntervalSeconds?: number;
}

export interface ProgressReportTool extends MuaddibTool {
  hasCallback: boolean;
  lastSentAt: number;
}

export function createProgressReportTool(options: ProgressReportToolOptions = {}): ProgressReportTool {
  const minInterval = (options.minIntervalSeconds ?? 15) * 1000;

  const tool: ProgressReportTool = {
    hasCallback: !!options.onProgressReport,
    lastSentAt: 0,
    name: "progress_report",
    persistType: "none",
    label: "Progress Report",
    description: "Send a short progress update while working on a response.",
    parameters: Type.Object({
      text: Type.String({
        description: "One-line progress update.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const clean = (params.text ?? "").replace(/\s+/g, " ").trim();
      if (!clean) {
        return {
          content: [{ type: "text", text: "OK" }],
          details: { reported: "" },
        };
      }

      const now = Date.now();
      if (now - tool.lastSentAt < minInterval) {
        const waitSec = Math.ceil((minInterval - (now - tool.lastSentAt)) / 1000);
        return {
          content: [{ type: "text", text: `OK (rate-limited, next report available in ~${waitSec}s)` }],
          details: { reported: clean, rateLimited: true },
        };
      }

      if (options.onProgressReport) {
        await options.onProgressReport(clean);
      }
      tool.lastSentAt = Date.now();

      return {
        content: [{ type: "text", text: "OK" }],
        details: { reported: clean },
      };
    },
  };

  return tool;
}

interface MakePlanToolOptions {
  chronicleStore?: ChronicleStore;
  currentQuestId?: string | null;
}

export function createMakePlanTool(options: MakePlanToolOptions = {}): MuaddibTool {
  return {
    name: "make_plan",
    persistType: "none",
    label: "Make Plan",
    description: "Capture a brief plan before continuing with work.",
    parameters: Type.Object({
      plan: Type.String({
        description: "Plan summary.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      if (options.chronicleStore && options.currentQuestId) {
        await options.chronicleStore.questSetPlan(options.currentQuestId, params.plan);
      }

      const suffix = options.currentQuestId
        ? " (stored for future quest steps)"
        : "";

      return {
        content: [{ type: "text", text: `OK, follow this plan${suffix}` }],
        details: {
          plan: params.plan,
        },
      };
    },
  };
}
