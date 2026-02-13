import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import { SessionRunner } from "../session-runner.js";
import type {
  BaselineToolExecutors,
  DefaultToolExecutorOptions,
  OracleInput,
} from "./types.js";

const DEFAULT_ORACLE_SYSTEM_PROMPT =
  "You are an oracle - a powerful reasoning entity consulted for complex analysis.";

/**
 * Tools excluded from the oracle's nested agentic loop to prevent recursion
 * and irrelevant side-effects.
 */
export const ORACLE_EXCLUDED_TOOLS = new Set([
  "oracle",
  "progress_report",
  "quest_start",
  "subquest_start",
  "quest_snooze",
]);

export function createOracleTool(executors: Pick<BaselineToolExecutors, "oracle">): AgentTool<any> {
  return {
    name: "oracle",
    label: "Oracle",
    description:
      "Consult the oracle - a more powerful reasoning model that may be consulted for complex analysis and creative work. " +
      "Invoke it whenever it would be helpful to get deep advice on complex problems or produce a high quality creative piece.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "The question or task for the oracle. Be extremely specific about what analysis, plan, or solution you need. " +
          "The Oracle will get access to the chat context, but not to your progress made on the last request so far.",
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

export function createDefaultOracleExecutor(
  options: DefaultToolExecutorOptions,
): BaselineToolExecutors["oracle"] {
  const modelAdapter = options.modelAdapter ?? new PiAiModelAdapter();

  return async (input: OracleInput): Promise<string> => {
    const query = input.query.trim();
    if (!query) {
      throw new Error("oracle.query must be non-empty.");
    }

    const configuredModel = toConfiguredString(options.oracleModel);
    if (!configuredModel) {
      throw new Error("oracle tool requires tools.oracle.model configuration.");
    }

    const systemPrompt = toConfiguredString(options.oraclePrompt) ?? DEFAULT_ORACLE_SYSTEM_PROMPT;

    // Filter tools: exclude oracle itself and tools that don't belong in nested loop
    const oracleTools = (options.oracleAgentTools ?? []).filter(
      (tool) => !ORACLE_EXCLUDED_TOOLS.has(tool.name),
    );

    const runner = new SessionRunner({
      model: configuredModel,
      systemPrompt,
      tools: oracleTools,
      modelAdapter,
      getApiKey: options.getApiKey,
      maxIterations: options.oracleMaxIterations,
    });

    try {
      const result = await runner.prompt(query, {
        contextMessages: options.oracleConversationContext,
        thinkingLevel: "high",
      });
      return result.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("iteration") || message.includes("max")) {
        return `Oracle exhausted iterations: ${message}`;
      }
      throw error;
    }
  };
}

function toConfiguredString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
