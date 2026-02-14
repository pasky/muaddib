import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import { SessionRunner } from "../session-runner.js";
import type { RunnerLogger, SessionFactoryContextMessage } from "../session-factory.js";
import type { DefaultToolExecutorOptions } from "./types.js";

export interface OracleInput {
  query: string;
}

export type OracleExecutor = (input: OracleInput) => Promise<string>;

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

const ORACLE_LOG_SEPARATOR = "----------------------------------------------";

export function createOracleTool(executors: { oracle: OracleExecutor }): AgentTool<any> {
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

/**
 * Per-invocation oracle context, mirroring Python's OracleExecutor constructor args.
 * Created once per command invocation after conversation context is known.
 */
export interface OracleInvocationContext {
  /** Conversation context at invocation time (passed to oracle's nested session). */
  conversationContext: SessionFactoryContextMessage[];

  /**
   * Factory that builds the full baseline tool set.
   * Injected to break the circular dependency (baseline-tools.ts → oracle.ts).
   * The oracle filters this through ORACLE_EXCLUDED_TOOLS.
   */
  buildTools: (options: DefaultToolExecutorOptions) => AgentTool<any>[];

  /** Tool options for building oracle's nested tools (arc, secrets, etc.). */
  toolOptions: DefaultToolExecutorOptions;
}

export function createDefaultOracleExecutor(
  options: DefaultToolExecutorOptions,
  invocation?: OracleInvocationContext,
): OracleExecutor {
  const modelAdapter = options.modelAdapter ?? new PiAiModelAdapter();
  // Cast to RunnerLogger — callers (command handler, CLI) pass full loggers;
  // the ToolExecutorLogger type is just narrower than what's actually provided.
  const logger = (options.logger ?? console) as RunnerLogger;

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

    // Build tools independently (like Python's get_tools_for_arc + EXCLUDED_TOOLS filter)
    const allTools = invocation
      ? invocation.buildTools(invocation.toolOptions)
      : [];
    const oracleTools = allTools.filter(
      (tool) => !ORACLE_EXCLUDED_TOOLS.has(tool.name),
    );

    const runner = new SessionRunner({
      model: configuredModel,
      systemPrompt,
      tools: oracleTools,
      modelAdapter,
      getApiKey: options.getApiKey,
      maxIterations: options.oracleMaxIterations,
      logger,
    });

    logger.info(`${ORACLE_LOG_SEPARATOR} CONSULTING ORACLE: ${query.slice(0, 500)}...`);

    try {
      const result = await runner.prompt(query, {
        contextMessages: invocation?.conversationContext,
        thinkingLevel: "high",
      });
      logger.info(`${ORACLE_LOG_SEPARATOR} Oracle response: ${result.text.slice(0, 500)}...`);
      return result.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("iteration") || message.includes("max")) {
        logger.info(`${ORACLE_LOG_SEPARATOR} Oracle exhausted: ${message}...`);
        return `Oracle exhausted iterations: ${message}`;
      }
      logger.info(`${ORACLE_LOG_SEPARATOR} Oracle failed: ${message}`);
      return `Oracle error: ${message}`;
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
