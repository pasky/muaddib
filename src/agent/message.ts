/**
 * Centralized helpers for narrowing and extracting content from AgentMessage.
 *
 * pi-ai provides discriminated unions (TextContent, ThinkingContent, ToolCall)
 * on AssistantMessage.content, but AgentMessage is a wider union.  These guards
 * and extractors eliminate the repeated `as` casts and inline
 * `.filter(b => b.type === "text").map(b => b.text).join()` pattern that was
 * duplicated across ~10 files.
 */

import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ── Type guards ──

export function isAssistantMessage(msg: AgentMessage): msg is AssistantMessage {
  return (msg as { role: string }).role === "assistant";
}

export function isToolResultMessage(msg: AgentMessage): msg is ToolResultMessage {
  return (msg as { role: string }).role === "toolResult";
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

/**
 * Extract inline <thinking> blocks from raw model text, returning the visible
 * remainder and the joined thinking content. Must run on raw text *before*
 * cleanResponseText() (command-executor.ts), whose IRC nick-strip regex would
 * eat a leading `<thinking>` as if it were `<SomeUser>` and leak the
 * reasoning body. Tags are matched case-insensitively with optional inner
 * whitespace. An unclosed `<thinking>` swallows to end of text (silence beats
 * leaking), and text preceding an unmatched `</thinking>` is treated as
 * reasoning too (its opener was in an earlier chunk).
 */
export function extractThinking(text: string): { text: string; thinking: string } {
  const parts: string[] = [];
  const capture = (block: string): string => {
    const inner = block.replace(/<\s*\/?\s*thinking\s*>/gi, "").trim();
    if (inner) parts.push(inner);
    return "";
  };
  const visible = text
    .replace(/<\s*thinking\s*>[\s\S]*?(?:<\s*\/\s*thinking\s*>|$)/gi, capture)
    // Anything left before a stray closer is reasoning continuation.
    .replace(/^[\s\S]*<\s*\/\s*thinking\s*>/i, capture)
    .trim();
  return { text: visible, thinking: parts.join("\n") };
}
