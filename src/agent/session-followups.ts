import type { MuaddibTool } from "./tools/baseline-tools.js";
import type { PromptResult } from "./session-runner.js";
import type { Logger } from "../app/logging.js";
import type { MemoryConfig, SkillsConfig } from "../config/muaddib-config.js";
import { loadArcMemoryFile, loadArcUserMemoryFile } from "./gondolin/index.js";
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

  // Look at the session branch, not session.messages: compaction truncates the
  // latter, and a long run is exactly the one whose tool results got summarized
  // away — still worth a wrap-up (the model has the compaction summary).
  const summaryToolNameSet = new Set(summaryToolNames);
  const hasSummaryToolResults = session.sessionManager.getBranch().some((entry) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult") {
      return false;
    }
    return !entry.message.isError && summaryToolNameSet.has(entry.message.toolName);
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

export function buildMemoryUpdatePrompt(
  arc: string,
  memoryConfig?: MemoryConfig,
  options?: { toolCallsCount?: number; skillsConfig?: SkillsConfig },
  nick?: string,
): string {
  const charLimit = memoryConfig?.charLimit ?? 6000;
  const content = loadArcMemoryFile(arc);

  const chars = content.length;
  const capacityWarning = (used: number, limit: number) => used >= limit * 0.8 ? " - nearly full, make room before adding" : "";

  const displayContent = content.trim() || "(empty - not yet created)";

  let prompt = `<meta>Session complete. DO NOT RESPOND ANYMORE.\n\nWrap-up task: Here is your current shared memory (${chars}/${charLimit} chars${capacityWarning(chars, charLimit)}):\n<memory file="/workspace/MEMORY.md">\n${displayContent}\n</memory>\nMEMORY.md is for behavioral directives (how to act, what to verify, communication rules) and factual corrections (things your training data gets wrong). This memory gets injected into every single session - therefore, you do not need to re-record what you said or found out (already captured in /chat_history) or what happenned (already captured in /chronicle). Prefer positive actionable rules ("verify before quoting") over prohibitions ("never fabricate"). If the current memory block doesn't conform to these instructions, adjust/prune it as needed.`;

  // Per-user memory section
  if (nick) {
    const userContent = loadArcUserMemoryFile(arc, nick);
    const userChars = userContent.length;
    const userCharLimit = Math.round(charLimit / 2);
    const userDisplayContent = userContent.trim() || "(empty - not yet created)";
    prompt += `\n\nPer-user memory for ${nick} (${userChars}/${userCharLimit} chars${capacityWarning(userChars, userCharLimit)}):\n<user-memory nick="${nick}" file="/workspace/users/${nick}.md">\n${userDisplayContent}\n</user-memory>\nUse /workspace/users/${nick}.md for how to interact with this user (communication preferences, corrections they have made, interaction style, critical personal context to keep in mind for most interactions). Not for logging what was discussed — that is in chat history or chronicle.`;
  }

  prompt += `\n\nIf this session revealed a behavioral correction or a factual error worth persisting, update the appropriate memory file using the edit or write tool. One rule per bullet. Terse is fine, but each bullet must read as a self-contained statement (what to do, when, and why if non-obvious) to a model that has never seen this session - no private shorthand. To make room, move the least valuable entries to /workspace/MEMORY_OVERFLOW.md (not injected, but greppable; prefix per-user entries with the nick) or condense; when condensing, think hard and doublecheck that every rewritten entry still decodes unambiguously from a blank context. If nothing worth saving (almost always!), do nothing.`;

  // Skill creation section - appended when session was complex enough
  const toolCallsCount = options?.toolCallsCount ?? 0;
  const threshold = options?.skillsConfig?.creationThreshold ?? 4;

  if (toolCallsCount >= threshold) {
    prompt += `\n\nSkill creation: this session used ${toolCallsCount} tool calls - was it tough? If you didn't follow an existing skill, consider saving a reusable skill using manage-skills. Skills allow you to continuously learn, but also carry a permanent token cost. So only if both:\n- The procedure was complex *and* hard to discover (required trial & error or user correction)\n- You could confirm this is a pattern you've encountered historically (grep history?) or are certain to need again\nIf it's not worth capturing, do nothing.`;
  }

  prompt += "</meta>";
  return prompt;
}
