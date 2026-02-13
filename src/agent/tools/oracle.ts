import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  completeSimple,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type UserMessage,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import type {
  BaselineToolExecutors,
  DefaultToolExecutorOptions,
  OracleInput,
} from "./types.js";

const DEFAULT_ORACLE_SYSTEM_PROMPT =
  "You are an oracle - a powerful reasoning entity consulted for complex analysis.";

type CompleteSimpleFn = (
  model: Model<any>,
  context: { messages: UserMessage[]; systemPrompt?: string },
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export function createOracleTool(executors: Pick<BaselineToolExecutors, "oracle">): AgentTool<any> {
  return {
    name: "oracle",
    label: "Oracle",
    description: "Consult the oracle model for deeper analysis or creative problem-solving guidance.",
    parameters: Type.Object({
      query: Type.String({
        description: "The question or task for the oracle.",
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
  const completeFn: CompleteSimpleFn = options.completeSimpleFn ?? completeSimple;

  return async (input: OracleInput): Promise<string> => {
    const query = input.query.trim();
    if (!query) {
      throw new Error("oracle.query must be non-empty.");
    }

    const configuredModel = toConfiguredString(options.oracleModel);
    if (!configuredModel) {
      throw new Error("oracle tool requires tools.oracle.model configuration.");
    }

    const resolvedModel = modelAdapter.resolve(configuredModel);
    const systemPrompt = toConfiguredString(options.oraclePrompt) ?? DEFAULT_ORACLE_SYSTEM_PROMPT;

    const response = await completeFn(
      resolvedModel.model,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: query,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: await resolveProviderApiKey(options, String(resolvedModel.model.provider)),
        reasoning: "high",
      },
    );

    const output = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!output) {
      throw new Error("oracle returned empty response.");
    }

    return output;
  };
}

async function resolveProviderApiKey(
  options: DefaultToolExecutorOptions,
  provider: string,
): Promise<string | undefined> {
  if (!options.getApiKey) {
    return undefined;
  }

  const key = await options.getApiKey(provider);
  return toConfiguredString(key);
}

function toConfiguredString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
