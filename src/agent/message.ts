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
  const { text: visible, captured } = extractTagged(text, "thinking");
  return { text: visible, thinking: captured };
}

/**
 * Extract `<status>...</status>` progress notes from raw model text. The
 * progress nudge asks for the one-line status in this tag precisely so the
 * runner can decide by itself whether it is deliverable: a status belongs to a
 * turn that goes on to call tools, and must be dropped when the model glues it
 * in front of its final answer.
 *
 * Deliberately narrow, because unlike <thinking> this tag is only requested
 * situationally (by the progress nudge) while parsing runs on every response:
 * only a *leading, closed* block counts. A stray `</status>`, an unclosed
 * opener, or `<status>` inside a sentence therefore never swallows an answer -
 * the worst case is a visible tag, not a lost message. `matched` reports
 * whether such a block was present, so empty tags are stripped, not leaked.
 */
export function extractStatus(text: string): { text: string; status: string; matched: boolean } {
  // Closed leading <thinking> blocks are transparent here (models routinely
  // emit inline reasoning first) but are preserved in the returned text, since
  // extractThinking() runs later and persists them as internal monologue.
  const leading = /^(\s*(?:<\s*thinking\s*>[\s\S]*?<\s*\/\s*thinking\s*>\s*)*)<\s*status\s*>([\s\S]*?)<\s*\/\s*status\s*>/i
    .exec(text);
  if (!leading) return { text, status: "", matched: false };
  const preserved = leading[1] ?? "";
  return {
    text: (preserved + text.slice(leading[0].length)).trim(),
    status: (leading[2] ?? "").trim(),
    matched: true,
  };
}

function extractTagged(text: string, tag: string): { text: string; captured: string } {
  const parts: string[] = [];
  const capture = (block: string): string => {
    const inner = block.replace(new RegExp(`<\\s*/?\\s*${tag}\\s*>`, "gi"), "").trim();
    if (inner) parts.push(inner);
    return "";
  };
  const visible = text
    .replace(new RegExp(`<\\s*${tag}\\s*>[\\s\\S]*?(?:<\\s*/\\s*${tag}\\s*>|$)`, "gi"), capture)
    // Anything left before a stray closer belongs to the tagged block too.
    .replace(new RegExp(`^[\\s\\S]*<\\s*/\\s*${tag}\\s*>`, "i"), capture)
    .trim();
  return { text: visible, captured: parts.join("\n") };
}
