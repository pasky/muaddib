import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { MuaddibTool, ToolPersistType } from "../../agent/tools/baseline-tools.js";
import type { PromptResult } from "../../agent/session-runner.js";
import type { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import type { Logger } from "../../app/logging.js";
import { truncateForDebug } from "../../agent/debug-utils.js";

const PERSISTENCE_SUMMARY_SYSTEM_PROMPT =
  "As an AI agent, you need to remember in the future what tools you used when generating a response, and what the tools told you. Summarize all tool uses in a single concise paragraph. If artifact links are included, include every artifact link and tie each link to the corresponding tool call.";

interface PersistentToolCall {
  toolName: string;
  input: unknown;
  output: unknown;
  persistType: ToolPersistType;
  artifactUrls: string[];
}

interface GenerateToolSummaryInput {
  result: PromptResult;
  tools: MuaddibTool[];
  persistenceSummaryModel: string | null;
  modelAdapter: PiAiModelAdapter;
  logger: Logger;
  arc?: string;
}

export async function generateToolSummaryFromSession(input: GenerateToolSummaryInput): Promise<string | null> {
  const {
    result,
    tools,
    persistenceSummaryModel,
    modelAdapter,
    logger,
    arc,
  } = input;

  if (!persistenceSummaryModel || !result.session) {
    return null;
  }

  const calls = collectPersistentToolCalls(result.session.messages, tools);
  if (calls.length === 0) {
    return null;
  }

  try {
    const summaryResponse = await modelAdapter.completeSimple(
      persistenceSummaryModel,
      {
        systemPrompt: PERSISTENCE_SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildPersistenceSummaryInput(calls),
            timestamp: Date.now(),
          },
        ],
      },
      {
        callType: "tool_persistence_summary",
        logger,
      },
    );

    const summaryText = summaryResponse.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

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

function collectPersistentToolCalls(messages: AgentMessage[], tools: MuaddibTool[]): PersistentToolCall[] {
  const toolPersistMap = new Map<string, ToolPersistType>();
  for (const tool of tools) {
    toolPersistMap.set(tool.name, tool.persistType);
  }

  return messages
    .filter((message) => message.role === "toolResult")
    .flatMap((message) => {
      const toolResult = message as AgentMessage & {
        toolName: string;
        details?: Record<string, unknown>;
        isError?: boolean;
      };
      if (toolResult.isError) {
        return [];
      }
      const policy = toolPersistMap.get(toolResult.toolName) ?? "none";
      if (policy !== "summary" && policy !== "artifact") {
        return [];
      }

      return [{
        toolName: toolResult.toolName,
        input: toolResult.details?.input,
        output: toolResult,
        persistType: policy,
        artifactUrls: extractArtifactUrls(toolResult),
      }];
    });
}

function buildPersistenceSummaryInput(persistentToolCalls: PersistentToolCall[]): string {
  const lines: string[] = ["The following tool calls were made during this conversation:"];

  for (const call of persistentToolCalls) {
    lines.push(`\n\n# Calling tool **${call.toolName}** (persist: ${call.persistType})`);
    lines.push(`## **Input:**\n${typeof call.input === "string" ? call.input : JSON.stringify(call.input, null, 2)}\n`);
    lines.push(`## **Output:**\n${typeof call.output === "string" ? call.output : JSON.stringify(call.output, null, 2)}\n`);

    for (const artifactUrl of call.artifactUrls) {
      lines.push(`(Tool call I/O stored as artifact: ${artifactUrl})\n`);
    }
  }

  lines.push("\nPlease provide a concise summary of what was accomplished in these tool calls.");
  return lines.join("\n");
}

function extractArtifactUrls(result: unknown): string[] {
  const urls = new Set<string>();

  if (!result || typeof result !== "object") {
    return [];
  }

  const record = result as Record<string, unknown>;
  const details = record.details as Record<string, unknown> | undefined;
  const artifactUrls = details?.artifactUrls;
  if (Array.isArray(artifactUrls)) {
    for (const artifactUrl of artifactUrls) {
      if (typeof artifactUrl === "string" && artifactUrl.trim().length > 0) {
        urls.add(artifactUrl.trim());
      }
    }
  }

  return Array.from(urls);
}

export function formatToolSummaryLogPreview(text: string, maxChars = 180): string {
  return truncateForDebug(text.replace(/\s+/gu, " ").trim(), maxChars);
}
