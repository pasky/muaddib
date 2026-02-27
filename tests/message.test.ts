import { describe, expect, it } from "vitest";

import {
  isAssistantMessage,
  isTextContent,
  isToolCall,
  responseText,
} from "../src/agent/message.js";

import type { AssistantMessage, TextContent, ToolCall } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("isAssistantMessage", () => {
  it("returns true for assistant messages", () => {
    const msg = makeAssistant([{ type: "text", text: "hi" }]);
    expect(isAssistantMessage(msg)).toBe(true);
  });

  it("returns false for user messages", () => {
    const msg: AgentMessage = { role: "user", content: "hello", timestamp: 0 };
    expect(isAssistantMessage(msg)).toBe(false);
  });

  it("returns false for toolResult messages", () => {
    const msg: AgentMessage = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [],
      isError: false,
      timestamp: 0,
    };
    expect(isAssistantMessage(msg)).toBe(false);
  });
});

describe("isTextContent", () => {
  it("narrows TextContent blocks", () => {
    const block: TextContent = { type: "text", text: "hello" };
    expect(isTextContent(block)).toBe(true);
    if (isTextContent(block)) {
      expect(block.text).toBe("hello");
    }
  });

  it("rejects non-text blocks", () => {
    expect(isTextContent({ type: "thinking" })).toBe(false);
    expect(isTextContent({ type: "toolCall" })).toBe(false);
    expect(isTextContent({ type: "image" })).toBe(false);
  });
});

describe("isToolCall", () => {
  it("narrows ToolCall blocks", () => {
    const block: ToolCall = { type: "toolCall", id: "c1", name: "bash", arguments: {} };
    expect(isToolCall(block)).toBe(true);
    if (isToolCall(block)) {
      expect(block.name).toBe("bash");
    }
  });

  it("rejects non-toolCall blocks", () => {
    expect(isToolCall({ type: "text" })).toBe(false);
  });
});

describe("responseText", () => {
  it("joins text blocks with default newline separator and trims", () => {
    const msg = makeAssistant([
      { type: "text", text: "line 1" },
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "line 2" },
    ]);
    expect(responseText(msg)).toBe("line 1\nline 2");
  });

  it("trims whitespace", () => {
    const msg = makeAssistant([
      { type: "text", text: "  hello  " },
    ]);
    expect(responseText(msg)).toBe("hello");
  });

  it("uses custom separator", () => {
    const msg = makeAssistant([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
    expect(responseText(msg, " ")).toBe("a b");
  });

  it("returns empty string when no text blocks", () => {
    const msg = makeAssistant([
      { type: "toolCall", id: "c1", name: "bash", arguments: {} },
    ]);
    expect(responseText(msg)).toBe("");
  });
});
