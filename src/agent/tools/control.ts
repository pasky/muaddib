import { Type } from "typebox";
import type { MuaddibTool } from "./types.js";

const MAKE_PLAN_PARAMETERS = Type.Object({
  plan: Type.String({
    description: "Plan summary.",
  }),
});

export function createMakePlanTool(): MuaddibTool<typeof MAKE_PLAN_PARAMETERS> {
  return {
    name: "make_plan",
    persistType: "none",
    label: "Make Plan",
    description: "Capture a brief plan before continuing with work.",
    parameters: MAKE_PLAN_PARAMETERS,
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
