import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import type { DefaultToolExecutorOptions } from "./types.js";

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

const DEFERRED_QUEST_TOOL_MESSAGE =
  "REJECTED: quests runtime is deferred in the TypeScript runtime (parity v1).";

export function createQuestStartTool(
  executors: { questStart: QuestStartExecutor },
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
  executors: { subquestStart: SubquestStartExecutor },
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
  executors: { questSnooze: QuestSnoozeExecutor },
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

export function createDefaultQuestStartExecutor(
  _options: DefaultToolExecutorOptions,
): QuestStartExecutor {
  return async (input: QuestStartInput): Promise<string> => {
    if (!toConfiguredString(input.id)) {
      throw new Error("quest_start.id must be non-empty.");
    }

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
  options: DefaultToolExecutorOptions,
): SubquestStartExecutor {
  return async (input: SubquestStartInput): Promise<string> => {
    if (!toConfiguredString(options.currentQuestId)) {
      return "Error: subquest_start requires an active quest context.";
    }

    if (!toConfiguredString(input.id)) {
      throw new Error("subquest_start.id must be non-empty.");
    }

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
  options: DefaultToolExecutorOptions,
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

function toConfiguredString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
