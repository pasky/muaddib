/**
 * Centralized helpers for narrowing and extracting content from AgentMessage.
 *
 * pi-ai provides discriminated unions (TextContent, ThinkingContent, ToolCall)
 * on AssistantMessage.content, but AgentMessage is a wider union.  These guards
 * and extractors eliminate the repeated `as` casts and inline
 * `.filter(b => b.type === "text").map(b => b.text).join()` pattern that was
 * duplicated across ~10 files.
 */

import type { AssistantMessage, TextContent, ToolCall } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ── Type guards ──

export function isAssistantMessage(msg: AgentMessage): msg is AssistantMessage {
  return (msg as { role: string }).role === "assistant";
}

export function isTextContent(block: { type: string }): block is TextContent {
  return block.type === "text";
}

export function isToolCall(block: { type: string }): block is ToolCall {
  return block.type === "toolCall";
}

// ── Content extractors ──

/** Extract joined, trimmed text from an AssistantMessage's content blocks. */
export function responseText(response: AssistantMessage, sep = "\n"): string {
  return response.content
    .filter(isTextContent)
    .map((b) => b.text)
    .join(sep)
    .trim();
}
