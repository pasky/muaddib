import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import type {
  BaselineToolExecutors,
  ChronicleAppendInput,
  ChronicleReadInput,
  DefaultToolExecutorOptions,
} from "./types.js";

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

export function createDefaultChronicleReadExecutor(
  options: DefaultToolExecutorOptions,
): BaselineToolExecutors["chronicleRead"] {
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
): BaselineToolExecutors["chronicleAppend"] {
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
