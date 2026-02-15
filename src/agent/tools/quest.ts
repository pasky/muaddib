import { Type } from "@sinclair/typebox";

import type { ToolContext, MuaddibTool } from "./types.js";
import { toConfiguredString } from "../../utils/index.js";

export interface QuestStartInput {
  id: string;
  goal: string;
  success_criteria: string;
}

export interface SubquestStartInput {
  id: string;
  goal: string;
  success_criteria: string;
}

export interface QuestSnoozeInput {
  until: string;
}

export type QuestStartExecutor = (input: QuestStartInput) => Promise<string>;
export type SubquestStartExecutor = (input: SubquestStartInput) => Promise<string>;
export type QuestSnoozeExecutor = (input: QuestSnoozeInput) => Promise<string>;

const VALID_QUEST_ID_RE = /^[a-zA-Z0-9_-]+$/;

function validateQuestId(questId: string): string | undefined {
  if (!questId) return "Quest ID cannot be empty";
  if (questId.length > 64) return "Quest ID too long (max 64 characters)";
  if (questId.includes(".")) return "Quest ID cannot contain dots (reserved for hierarchy)";
  if (!VALID_QUEST_ID_RE.test(questId)) return "Quest ID can only contain letters, numbers, hyphens, and underscores";
  return undefined;
}

const DEFERRED_QUEST_TOOL_MESSAGE =
  "REJECTED: quests runtime is deferred in the TypeScript runtime (parity v1).";

export function createQuestStartTool(
  executors: { questStart: QuestStartExecutor },
): MuaddibTool {
  return {
    name: "quest_start",
    persistType: "summary",
    label: "Quest Start",
    description:
      "Start a new quest for yourself. Only use on explicit user request for a multi-step autonomous task. The quest system will periodically advance the quest until success criteria are met. MUST be called alongside final_answer in the same turn.",
    parameters: Type.Object({
      id: Type.String({
        description: "Unique quest identifier (letters, numbers, hyphens, underscores only). Example: 'check-xmas25-news-tuesday'",
      }),
      goal: Type.String({
        description: "Clear description of what the quest should accomplish.",
      }),
      success_criteria: Type.String({
        description: "Specific, measurable criteria for when the quest is complete.",
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
  executors: { subquestStart: SubquestStartExecutor },
): MuaddibTool {
  return {
    name: "subquest_start",
    persistType: "summary",
    label: "Subquest Start",
    description:
      "Start a subquest to fully focus on a particular task of the current quest. When the subquest finishes, the parent quest resumes. BEFORE starting subquests, call make_plan to outline your approach - the plan will be included in context for all future quest steps and can be updated via subsequent make_plan calls. If starting multiple subquests, do not call this tool in parallel for subquests that depend on each other. MUST be called alongside final_answer in the same turn.",
    parameters: Type.Object({
      id: Type.String({
        description: "Subquest identifier (letters, numbers, hyphens, underscores only). Will be prefixed with parent quest ID.",
      }),
      goal: Type.String({
        description: "Clear description of what this subquest should accomplish.",
      }),
      success_criteria: Type.String({
        description: "Specific criteria for when this subquest is complete.",
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
  executors: { questSnooze: QuestSnoozeExecutor },
): MuaddibTool {
  return {
    name: "quest_snooze",
    persistType: "summary",
    label: "Quest Snooze",
    description:
      "Snooze the current quest until a specified time. MUST be called alongside final_answer in the same turn - you will be pinged to resume the quest at the specified time.",
    parameters: Type.Object({
      until: Type.String({
        description: "Time to resume the quest in HH:MM format (24-hour). If the time is in the past today, it will be interpreted as tomorrow.",
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

export function createDefaultQuestStartExecutor(
  _options: ToolContext,
): QuestStartExecutor {
  return async (input: QuestStartInput): Promise<string> => {
    const idErr = validateQuestId(input.id);
    if (idErr) return `Error: ${idErr}`;

    if (!toConfiguredString(input.goal)) {
      throw new Error("quest_start.goal must be non-empty.");
    }

    if (!toConfiguredString(input.success_criteria)) {
      throw new Error("quest_start.success_criteria must be non-empty.");
    }

    return DEFERRED_QUEST_TOOL_MESSAGE;
  };
}

export function createDefaultSubquestStartExecutor(
  options: ToolContext,
): SubquestStartExecutor {
  return async (input: SubquestStartInput): Promise<string> => {
    if (!toConfiguredString(options.currentQuestId)) {
      return "Error: subquest_start requires an active quest context.";
    }

    const idErr = validateQuestId(input.id);
    if (idErr) return `Error: ${idErr}`;

    if (!toConfiguredString(input.goal)) {
      throw new Error("subquest_start.goal must be non-empty.");
    }

    if (!toConfiguredString(input.success_criteria)) {
      throw new Error("subquest_start.success_criteria must be non-empty.");
    }

    return DEFERRED_QUEST_TOOL_MESSAGE;
  };
}

export function createDefaultQuestSnoozeExecutor(
  options: ToolContext,
): QuestSnoozeExecutor {
  return async (input: QuestSnoozeInput): Promise<string> => {
    if (!toConfiguredString(options.currentQuestId)) {
      return "Error: quest_snooze requires an active quest context.";
    }

    const until = input.until.trim();
    const match = until.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      return "Error: Invalid time format. Use HH:MM (e.g., 14:30)";
    }

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) {
      return "Error: Invalid time. Hours must be 0-23, minutes 0-59";
    }

    return DEFERRED_QUEST_TOOL_MESSAGE;
  };
}
