import { Type } from "@sinclair/typebox";

import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import { SessionRunner } from "../session-runner.js";
import type { MuaddibTool, ToolContext, ToolSet } from "./types.js";
import type { Message } from "@mariozechner/pi-ai";
import type { RunnerLogger } from "../session-factory.js";
import { stringifyError, toConfiguredString } from "../../utils/index.js";
import { withCostSpan } from "../../cost/cost-span.js";
import { LLM_CALL_TYPE } from "../../cost/llm-call-type.js";
import { iterationsToSessionLimits } from "../../config/muaddib-config.js";
import {
  createDefaultWebSearchExecutor,
  createDefaultVisitWebpageExecutor,
  createWebSearchTool,
  createVisitWebpageTool,
} from "./web.js";

export interface DeepResearchInput {
  query: string;
}

export type DeepResearchExecutor = (input: DeepResearchInput) => Promise<string>;

const DEFAULT_DEEP_RESEARCH_SYSTEM_PROMPT =
  "You are a web research specialist. Your job is to conduct thorough, breadth-first web research " +
  "to gather information on a topic. Search broadly, follow leads, cross-reference sources, and " +
  "synthesize findings into a comprehensive answer. Cite sources using extensive verbatim quotes in the format <quote src=\"url\">...</quote> as your output must be precise (preserving any and all nuance) and verifiable.";

const DEEP_RESEARCH_LOG_SEPARATOR = "----------------------------------------------";

export function createDeepResearchTool(executors: { deepResearch: DeepResearchExecutor }, modelId?: string): MuaddibTool {
  const modelClause = modelId ? ` (${modelId})` : "";
  return {
    name: "deep_research",
    persistType: "summary",
    label: "Deep Research",
    description:
      `Launch a web researcher ${modelClause} - a fast agent ` +
      "equipped with web_search and visit_webpage tools. Rule of thumb: use it any time you would expect to chain web_search + visit_webpage tools yourself. Advisory: results are best-effort and " +
      "may require an additional validation on challenging or nuanced questions.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "The research question or topic. Be extremely specific about what information you researched. " +
          "The research agent will get access to the chat context, but not to your progress made on the last request so far.",
      }),
    }),
    execute: async (_toolCallId, params: DeepResearchInput) => {
      const output = await executors.deepResearch(params);
      return {
        content: [{ type: "text", text: output }],
        details: {
          kind: "deep_research",
          query: params.query,
        },
      };
    },
  };
}

/**
 * Per-invocation deep research context.
 * Simpler than OracleInvocationContext — only needs conversation context
 * (no buildTools/toolOptions since we build web tools directly).
 */
export interface DeepResearchInvocationContext {
  /** Conversation context at invocation time (passed to the nested session). */
  conversationContext: Message[];
}

export function createDefaultDeepResearchExecutor(
  options: ToolContext,
  invocation?: DeepResearchInvocationContext,
): DeepResearchExecutor {
  const modelAdapter = options.modelAdapter as PiAiModelAdapter;
  const logger = (options.logger ?? console) as RunnerLogger;

  return async (input: DeepResearchInput): Promise<string> => {
    const query = input.query.trim();
    if (!query) {
      throw new Error("deep_research.query must be non-empty.");
    }

    const configuredModel = toConfiguredString(options.toolsConfig?.deepResearch?.model);
    if (!configuredModel) {
      throw new Error("deep_research tool requires tools.deepResearch.model configuration.");
    }

    const systemPrompt = toConfiguredString(options.toolsConfig?.deepResearch?.prompt) ?? DEFAULT_DEEP_RESEARCH_SYSTEM_PROMPT;

    // Build web-only tools directly — no Gondolin VM needed.
    const webSearchExecutor = createDefaultWebSearchExecutor(options);
    const visitWebpageExecutor = createDefaultVisitWebpageExecutor(options);
    const webTools: ToolSet = {
      tools: [
        createWebSearchTool({ webSearch: webSearchExecutor }),
        createVisitWebpageTool({ visitWebpage: visitWebpageExecutor }),
      ],
    };

    const runner = new SessionRunner({
      model: configuredModel,
      systemPrompt,
      toolSet: webTools,
      modelAdapter,
      authStorage: options.authStorage,
      sessionLimits: iterationsToSessionLimits(options.toolsConfig?.deepResearch?.maxIterations),
      logger,
    });

    logger.info(`${DEEP_RESEARCH_LOG_SEPARATOR} DEEP RESEARCH: ${query.slice(0, 500)}...`);

    try {
      const result = await withCostSpan(LLM_CALL_TYPE.DEEP_RESEARCH, { arc: options.arc }, async () => await runner.prompt(query, {
        contextMessages: invocation?.conversationContext,
        thinkingLevel: "low",
      }));
      logger.info(`${DEEP_RESEARCH_LOG_SEPARATOR} Deep research response: ${result.text.slice(0, 500)}...`);
      return result.text;
    } catch (error) {
      const message = stringifyError(error);
      if (message.includes("iteration") || message.includes("max")) {
        logger.info(`${DEEP_RESEARCH_LOG_SEPARATOR} Deep research exhausted: ${message}...`);
        return `Deep research exhausted iterations: ${message}`;
      }
      logger.info(`${DEEP_RESEARCH_LOG_SEPARATOR} Deep research failed: ${message}`);
      throw error;
    }
  };
}
