import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { MuaddibTool } from "./tools/baseline-tools.js";
import type { PromptResult } from "./session-runner.js";
import type { Logger } from "../app/logging.js";
import { withCostSpan } from "../cost/cost-span.js";
import { LLM_CALL_TYPE } from "../cost/llm-call-type.js";
import { truncateForDebug } from "./debug-utils.js";

interface GenerateToolSummaryInput {
  result: PromptResult;
  tools: MuaddibTool[];
  logger: Logger;
  sessionQueryId?: string;
  arc?: string;
}

export async function generateToolSummaryFromSession(input: GenerateToolSummaryInput): Promise<string | null> {
  const {
    result,
    tools,
    logger,
    sessionQueryId,
    arc,
  } = input;

  const session = result.session;
  if (!session || !result.followUp) {
    return null;
  }

  const summaryToolNames = tools
    .filter((tool) => tool.persistType === "summary")
    .map((tool) => tool.name);

  if (summaryToolNames.length === 0) {
    return null;
  }

  const summaryToolNameSet = new Set(summaryToolNames);
  const hasSummaryToolResults = session.messages.some((message) => {
    if (message.role !== "toolResult") {
      return false;
    }

    const toolResult = message as AgentMessage & {
      toolName: string;
      isError?: boolean;
    };

    return !toolResult.isError && summaryToolNameSet.has(toolResult.toolName);
  });

  if (!hasSummaryToolResults) {
    return null;
  }

  return await withCostSpan(
    LLM_CALL_TYPE.TOOL_SUMMARY,
    arc ? { arc } : {},
    async () => await generateInSessionToolSummary(result.followUp!, summaryToolNames, logger, sessionQueryId, arc),
  );
}

/** In-session follow-up — reuses cached conversation context (cheap cache reads). */
async function generateInSessionToolSummary(
  followUp: NonNullable<PromptResult["followUp"]>,
  summaryToolNames: string[],
  logger: Logger,
  sessionQueryId?: string,
  arc?: string,
): Promise<string | null> {
  let summaryText: string | null;
  try {
    summaryText = await followUp(buildToolSummaryFollowUpPrompt(summaryToolNames, { sessionQueryId }));
  } catch (error) {
    logger.error("In-session tool summary failed", error);
    return null;
  }

  if (summaryText) {
    logger.debug(
      "Generated in-session tool summary",
      `arc=${arc ?? "unknown"}`,
      `chars=${summaryText.length}`,
      `summary=${formatToolSummaryLogPreview(summaryText)}`,
    );
  }

  return summaryText;
}

/**
 * Build a follow-up prompt for in-session tool summary generation.
 * Uses the same `<meta>Session complete.` envelope as memory update prompts.
 */
export function buildToolSummaryFollowUpPrompt(
  summaryToolNames: string[],
  options: { sessionQueryId?: string } = {},
): string {
  const toolList = summaryToolNames.join(", ");
  const sessionQueryReference = options.sessionQueryId
    ? `Use session_query id \`${options.sessionQueryId}\` for this session, and cite that id explicitly even if the working directory belongs to a parent command session.`
    : "Cite the <slug> from /workspace/.sessions/session-<slug>/ explicitly so later turns can replay this session via the session_query tool.";

  return [
    "<meta>Session complete. DO NOT RESPOND ANYMORE.",
    "",
    `Wrap-up task: As an AI agent, you need to remember in the future what tools you used when generating a response, and what the tools told you. Summarize the tool calls from this session in a single concise paragraph. Only cover these tools: ${toolList}. Include every artifact link and tie each link to the corresponding tool call. Include /workspace/.sessions/session-<slug>/ working directory paths so you can return to previous work. ${sessionQueryReference} Do NOT use any tools.`,
    "</meta>",
  ].join("\n");
}

export function formatToolSummaryLogPreview(text: string, maxChars = 180): string {
  return truncateForDebug(text.replace(/\s+/gu, " ").trim(), maxChars);
}
