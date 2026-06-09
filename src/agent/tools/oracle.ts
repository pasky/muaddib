import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { iterationsToSessionLimits } from "../../config/muaddib-config.js";
import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import { stringifyError, toConfiguredString } from "../../utils/index.js";
import { withCostSpan } from "../../cost/cost-span.js";
import { LLM_CALL_TYPE } from "../../cost/llm-call-type.js";
import type { RunnerLogger } from "../session-factory.js";
import { SessionRunner, type PromptResult } from "../session-runner.js";
import { generateToolSummaryFromSession } from "../tool-summary.js";
import type { MuaddibTool, ToolContext, ToolSet } from "./types.js";

export interface OracleInput {
  query: string;
}

export type OracleExecutor = (input: OracleInput) => Promise<string>;

const ORACLE_PARAMETERS = Type.Object({
  query: Type.String({
    description:
      "The question or task for the oracle. Be extremely specific about what analysis, plan, or solution you need. " +
      "The Oracle will get access to the chat context, but not to your progress made on the last request so far.",
  }),
});

const DEFAULT_ORACLE_SYSTEM_PROMPT =
  "You are an oracle - a powerful reasoning entity consulted for complex analysis.";

/**
 * Tools excluded from the oracle's nested agentic loop to prevent recursion
 * and irrelevant side-effects.
 */
export const ORACLE_EXCLUDED_TOOLS = new Set([
  "oracle",
  "deep_research",
]);

const ORACLE_LOG_SEPARATOR = "----------------------------------------------";
const VALID_ORACLE_THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function getOracleThinkingLevel(value: unknown): ThinkingLevel {
  if (value === undefined) {
    return "high";
  }
  if (typeof value === "string" && VALID_ORACLE_THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(
    `Invalid tools.oracle.thinkingLevel '${String(value)}'. Valid values: ${[...VALID_ORACLE_THINKING_LEVELS].join(", ")}`,
  );
}

export function createOracleTool(
  executors: { oracle: OracleExecutor },
  modelId?: string,
): MuaddibTool<typeof ORACLE_PARAMETERS> {
  const modelClause = modelId ? ` (${modelId})` : "";
  return {
    name: "oracle",
    persistType: "summary",
    label: "Oracle",
    description:
      `Consult the oracle${modelClause} - a more powerful reasoning model that may be consulted for complex analysis and creative work. ` +
      "Invoke it whenever it would be helpful to get deep advice on complex problems or produce a high quality creative piece. " +
      "If you are going to call this tool, also send the user a very short one-line note at the same moment.",
    parameters: ORACLE_PARAMETERS,
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
  conversationContext: Message[];

  /**
   * Lazily returns the current invocation's tool set.
   * The oracle reuses these tool instances so sandbox-backed tools operate in
   * the exact same /workspace/.sessions/session-<slug>/ working directory as
   * the parent agent.  The oracle runner deliberately does not own disposal of
   * this shared tool set; the parent SessionRunner checkpoints it when the
   * user-visible command finishes.
   */
  getToolSet: () => ToolSet;
}

export function createDefaultOracleExecutor(
  options: ToolContext,
  invocation?: OracleInvocationContext,
): OracleExecutor {
  const modelAdapter = options.modelAdapter as PiAiModelAdapter;
  // Cast to RunnerLogger — callers (command handler, CLI) pass full loggers;
  // the ToolExecutorLogger type is just narrower than what's actually provided.
  const logger = (options.logger ?? console) as RunnerLogger;

  return async (input: OracleInput): Promise<string> => {
    const query = input.query.trim();
    if (!query) {
      throw new Error("oracle.query must be non-empty.");
    }

    const configuredModel = toConfiguredString(options.toolsConfig?.oracle?.model);
    if (!configuredModel) {
      throw new Error("oracle tool requires tools.oracle.model configuration.");
    }

    const systemPrompt = toConfiguredString(options.toolsConfig?.oracle?.prompt) ?? DEFAULT_ORACLE_SYSTEM_PROMPT;
    const thinkingLevel = getOracleThinkingLevel(options.toolsConfig?.oracle?.thinkingLevel);

    const toolSet = invocation
      ? invocation.getToolSet()
      : { tools: [] };
    const oracleRecordId = toolSet.sessionHostDir
      ? `oracle-${randomUUID().slice(0, 8)}`
      : undefined;
    const oracleRecordFile = oracleRecordId
      ? `${oracleRecordId}.session-record.jsonl`
      : undefined;
    const oracleSessionQueryId = toolSet.sessionHostDir && oracleRecordId
      ? `${basename(toolSet.sessionHostDir)}/${oracleRecordId}`
      : undefined;
    const oracleToolSet: ToolSet = {
      ...toolSet,
      // Reuse the parent's tool instances (and therefore the parent's exact
      // Gondolin CWD), but do not dispose/checkpoint them from the nested
      // oracle runner.  The parent runner still owns the shared tool set.
      dispose: undefined,
      tools: toolSet.tools.filter((tool) => !ORACLE_EXCLUDED_TOOLS.has(tool.name)),
    };

    const runner = new SessionRunner({
      model: configuredModel,
      systemPrompt,
      toolSet: oracleToolSet,
      modelAdapter,
      authStorage: options.authStorage,
      sessionLimits: iterationsToSessionLimits(options.toolsConfig?.oracle?.maxIterations),
      logger,
      sessionFile: oracleToolSet.sessionHostDir && oracleRecordFile
        ? join(oracleToolSet.sessionHostDir, oracleRecordFile)
        : undefined,
    });

    logger.info(`${ORACLE_LOG_SEPARATOR} CONSULTING ORACLE: ${query.slice(0, 500)}...`);

    let result: PromptResult | undefined;
    try {
      result = await withCostSpan(LLM_CALL_TYPE.ORACLE, { arc: options.arc }, async () => await runner.prompt(query, {
        contextMessages: invocation?.conversationContext,
        thinkingLevel,
      }));
      logger.info(`${ORACLE_LOG_SEPARATOR} Oracle response: ${result.text.slice(0, 500)}...`);
      const toolSummary = await generateToolSummaryFromSession({
        result,
        tools: oracleToolSet.tools,
        logger,
        model: configuredModel,
        sessionQueryId: oracleSessionQueryId,
        arc: options.arc,
      });
      return toolSummary ? `${result.text}\n\n${toolSummary}` : result.text;
    } catch (error) {
      const message = stringifyError(error);
      if (message.includes("iteration") || message.includes("max")) {
        logger.info(`${ORACLE_LOG_SEPARATOR} Oracle exhausted: ${message}...`);
        return `Oracle exhausted iterations: ${message}`;
      }
      logger.info(`${ORACLE_LOG_SEPARATOR} Oracle failed: ${message}`);
      throw error;
    } finally {
      await result?.session?.dispose();
    }
  };
}
