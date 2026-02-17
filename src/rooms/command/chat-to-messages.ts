/**
 * Convert simple {role, content} chat history entries to pi-ai Message objects
 * with proper role typing (user vs assistant).
 */
import type { AssistantMessage, Message, UserMessage } from "@mariozechner/pi-ai";
const STUB_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

export function chatEntryToMessage(entry: { role: string; content: string }): Message {
  if (entry.role === "assistant") {
    return {
      role: "assistant",
      content: [{ type: "text", text: entry.content }],
      api: "",
      provider: "",
      model: "",
      usage: STUB_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    } satisfies AssistantMessage;
  }
  return {
    role: "user",
    content: entry.content,
    timestamp: Date.now(),
  } satisfies UserMessage;
}

export function chatContextToMessages(
  context: Array<{ role: string; content: string }>,
): Message[] {
  return context.map(chatEntryToMessage);
}
