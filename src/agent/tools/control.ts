import { Type } from "@sinclair/typebox";
import type { MuaddibTool } from "./types.js";

export function createMakePlanTool(): MuaddibTool {
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
      return {
        content: [{ type: "text", text: "OK, follow this plan" }],
        details: {
          plan: params.plan,
        },
      };
    },
  };
}
