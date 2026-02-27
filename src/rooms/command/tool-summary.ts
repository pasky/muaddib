import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { isAssistantMessage, isToolCall, responseText } from "../../agent/message.js";
import type { MuaddibTool, ToolPersistType } from "../../agent/tools/baseline-tools.js";
import type { PromptResult } from "../../agent/session-runner.js";
import type { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import type { Logger } from "../../app/logging.js";
import { stripBinaryContent, truncateForDebug } from "../../agent/debug-utils.js";

const PERSISTENCE_SUMMARY_SYSTEM_PROMPT =
  "As an AI agent, you need to remember in the future what tools you used when generating a response, and what the tools told you. Summarize all tool uses in a single concise paragraph. If artifact links are included, include every artifact link and tie each link to the corresponding tool call. Include /tmp/session-* working directory paths so you can return to previous work.";

interface PersistentToolCall {
  toolName: string;
  input: unknown;
  output: unknown;
}

interface GenerateToolSummaryInput {
  result: PromptResult;
  tools: MuaddibTool[];
  persistenceSummaryModel: string | null;
  modelAdapter: PiAiModelAdapter;
  logger: Logger;
  arc?: string;
  /** Assistant text produced during the post-session memory update phase. */
  memoryUpdateText?: string;
}

export async function generateToolSummaryFromSession(input: GenerateToolSummaryInput): Promise<string | null> {
  const {
    result,
    tools,
    persistenceSummaryModel,
    logger,
    arc,
  } = input;

  if (persistenceSummaryModel == null || !result.session) {
    return null;
  }

  const calls = collectPersistentToolCalls(result.session.messages, tools);
  if (calls.length === 0) {
    return null;
  }

  if (persistenceSummaryModel === "") {
    return generateInSessionToolSummary(input, logger, arc);
  }

  return generateDedicatedModelToolSummary(input, calls, logger, arc);
}

/** In-session follow-up — reuses cached conversation context (cheap cache reads). */
async function generateInSessionToolSummary(
  input: GenerateToolSummaryInput,
  logger: Logger,
  arc?: string,
): Promise<string | null> {
  const { result, tools } = input;
  const session = result.session!;
  const preSummaryMsgCount = session.messages.length;

  try {
    result.bumpMaxIterations?.(2);
    await session.prompt(buildToolSummaryFollowUpPrompt(tools));
  } catch (error) {
    logger.error("In-session tool summary failed", error);
    return null;
  }

  const summaryText = extractAssistantText(
    session.messages.slice(preSummaryMsgCount),
  );

  if (summaryText) {
    logger.debug(
      "Generated in-session tool summary",
      `arc=${arc ?? "unknown"}`,
      `chars=${summaryText.length}`,
      `summary=${formatToolSummaryLogPreview(summaryText)}`,
    );
  }

  return summaryText ?? null;
}

/** Dedicated model single-shot completion (existing path). */
async function generateDedicatedModelToolSummary(
  input: GenerateToolSummaryInput,
  calls: PersistentToolCall[],
  logger: Logger,
  arc?: string,
): Promise<string | null> {
  const { persistenceSummaryModel, modelAdapter, memoryUpdateText } = input;

  try {
    const summaryResponse = await modelAdapter.completeSimple(
      persistenceSummaryModel!,
      {
        systemPrompt: PERSISTENCE_SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildPersistenceSummaryInput(calls, memoryUpdateText),
            timestamp: Date.now(),
          },
        ],
      },
      {
        callType: "tool_persistence_summary",
        logger,
      },
    );

    const summaryText = responseText(summaryResponse);

    logger.debug(
      "Generated internal monologue summary",
      `arc=${arc ?? "unknown"}`,
      `chars=${summaryText.length}`,
      `summary=${formatToolSummaryLogPreview(summaryText)}`,
    );

    return summaryText || null;
  } catch (error) {
    logger.error("Failed to generate tool persistence summary", error);
    return null;
  }
}

export function collectPersistentToolCalls(messages: AgentMessage[], tools: MuaddibTool[]): PersistentToolCall[] {
  const toolPersistMap = new Map<string, ToolPersistType>();
  for (const tool of tools) {
    toolPersistMap.set(tool.name, tool.persistType);
  }

  // Build a map from toolCallId → arguments by scanning assistant messages.
  const toolCallArgs = new Map<string, unknown>();
  for (const message of messages) {
    if (!isAssistantMessage(message)) continue;
    for (const block of message.content) {
      if (isToolCall(block)) {
        toolCallArgs.set(block.id, block.arguments);
      }
    }
  }

  return messages
    .filter((message) => message.role === "toolResult")
    .flatMap((message) => {
      const toolResult = message as AgentMessage & {
        toolCallId?: string;
        toolName: string;
        details?: Record<string, unknown>;
        isError?: boolean;
      };
      if (toolResult.isError) {
        return [];
      }
      const policy = toolPersistMap.get(toolResult.toolName) ?? "none";
      if (policy !== "summary") {
        return [];
      }

      const input = toolResult.toolCallId ? toolCallArgs.get(toolResult.toolCallId) : undefined;

      return [{
        toolName: toolResult.toolName,
        input,
        output: toolResult,
      }];
    });
}

function buildPersistenceSummaryInput(persistentToolCalls: PersistentToolCall[], memoryUpdateText?: string): string {
  const lines: string[] = ["The following tool calls were made during this conversation:"];

  for (const call of persistentToolCalls) {
    lines.push(`\n\n# Calling tool **${call.toolName}**`);
    const inputText = call.input === undefined ? "(unavailable)" : typeof call.input === "string" ? call.input : JSON.stringify(call.input, null, 2);
    lines.push(`## **Input:**\n${inputText}\n`);
    const sanitizedOutput = stripBinaryContent(call.output);
    lines.push(`## **Output:**\n${typeof sanitizedOutput === "string" ? sanitizedOutput : JSON.stringify(sanitizedOutput, null, 2)}\n`);
  }

  if (memoryUpdateText) {
    lines.push(`\n\n# Post-session memory update reasoning\n${memoryUpdateText}`);
  }

  lines.push("\nPlease provide a concise summary of what was accomplished in these tool calls.");
  return lines.join("\n");
}

/**
 * Build a follow-up prompt for in-session tool summary generation.
 * Uses the same `<meta>Session complete.` envelope as memory update prompts.
 */
export function buildToolSummaryFollowUpPrompt(tools: MuaddibTool[]): string {
  const summaryToolNames = tools
    .filter((t) => t.persistType === "summary")
    .map((t) => t.name);

  const toolList = summaryToolNames.join(", ");

  return [
    "<meta>Session complete. DO NOT RESPOND ANYMORE.",
    "",
    `Wrap-up task: As an AI agent, you need to remember in the future what tools you used when generating a response, and what the tools told you. Summarize the tool calls from this session in a single concise paragraph. Only cover these tools: ${toolList}. Include every artifact link and tie each link to the corresponding tool call. Include /tmp/session-* working directory paths so you can return to previous work. Do NOT use any tools.`,
    "</meta>",
  ].join("\n");
}

export function formatToolSummaryLogPreview(text: string, maxChars = 180): string {
  return truncateForDebug(text.replace(/\s+/gu, " ").trim(), maxChars);
}

/** Extract concatenated text blocks from assistant messages in a message slice. */
export function extractAssistantText(messages: AgentMessage[]): string | undefined {
  const parts: string[] = [];
  for (const msg of messages) {
    if (!isAssistantMessage(msg)) continue;
    const text = responseText(msg);
    if (text) {
      parts.push(text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined || undefined;
}
