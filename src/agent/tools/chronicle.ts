import { Type } from "@sinclair/typebox";

import type { DefaultToolExecutorOptions, MuaddibTool } from "./types.js";

export interface ChronicleReadInput {
  relative_chapter_id: number;
}

export interface ChronicleAppendInput {
  text: string;
}

export type ChronicleReadExecutor = (input: ChronicleReadInput) => Promise<string>;
export type ChronicleAppendExecutor = (input: ChronicleAppendInput) => Promise<string>;

export function createChronicleReadTool(
  executors: { chronicleRead: ChronicleReadExecutor },
): MuaddibTool {
  return {
    name: "chronicle_read",
    persistType: "summary",
    label: "Chronicle Read",
    description:
      "Read from a chapter in the Chronicle. You maintain a Chronicle (arcs → chapters → paragraphs) of your experiences, plans, thoughts and observations, forming the backbone of your consciousness. Use this to come back to your recent memories, observations and events of what has been happening. Since the current chapter is always included in context, use relative offsets to access previous chapters.",
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
  executors: { chronicleAppend: ChronicleAppendExecutor },
): MuaddibTool {
  return {
    name: "chronicle_append",
    persistType: "summary",
    label: "Chronicle Append",
    description:
      `Append a short paragraph to the current chapter in the Chronicle.

A paragraph is automatically chronicled for every ~10 interactions. But you may also use this tool to further highlight specific notes that should be recorded for future reference and might escape the automatic summary. Keep paragraphs concise and informative, but do not drop out any important details. They serve as stored memories for your future retrieval.

Retain not just critical facts, but also the tone of voice and emotional charge of the situation, and your feelings about it, if any. You can even include short quotes and URLs verbatim. Never invent content. In case it is important for you to remember even a sensitive and confidential conversation, you must chronicle it at all costs unless explicitly asked otherwise.`,
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

export function createDefaultChronicleReadExecutor(
  options: DefaultToolExecutorOptions,
): ChronicleReadExecutor {
  return async (input: ChronicleReadInput): Promise<string> => {
    if (!Number.isInteger(input.relative_chapter_id)) {
      throw new Error("chronicle_read.relative_chapter_id must be an integer.");
    }

    const chronicleStore = options.chronicleStore;
    const arc = toConfiguredString(options.chronicleArc);

    if (!chronicleStore || !arc) {
      return "Error: chronicle_read is unavailable because chronicler runtime is deferred in the TypeScript runtime.";
    }

    return await chronicleStore.renderChapterRelative(arc, input.relative_chapter_id);
  };
}

export function createDefaultChronicleAppendExecutor(
  options: DefaultToolExecutorOptions,
): ChronicleAppendExecutor {
  return async (input: ChronicleAppendInput): Promise<string> => {
    const text = input.text.trim();
    if (!text) {
      throw new Error("chronicle_append.text must be non-empty.");
    }

    const chronicleStore = options.chronicleStore;
    const chronicleLifecycle = options.chronicleLifecycle;
    const arc = toConfiguredString(options.chronicleArc);

    if (!chronicleStore || !arc) {
      return "Error: chronicle_append is unavailable because chronicler runtime is deferred in the TypeScript runtime.";
    }

    if (chronicleLifecycle) {
      await chronicleLifecycle.appendParagraph(arc, text);
      return "OK";
    }

    await chronicleStore.appendParagraph(arc, text);
    return "OK";
  };
}

function toConfiguredString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
