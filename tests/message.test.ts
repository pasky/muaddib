import { describe, expect, it } from "vitest";

import {
  extractStatus,
  extractThinking,
  isAssistantMessage,
  isTextContent,
  isToolCall,
  responseText,
} from "../src/agent/message.js";
import { createSteeredPassiveAwareConvertToLlm } from "../src/agent/session-factory.js";
import {
  buildSteeredPassiveMessage,
  dmCommandReference,
  MUADDIB_STEERED_PASSIVE_CUSTOM_TYPE,
  renderSteeredPassive,
} from "../src/rooms/message.js";

describe("dmCommandReference", () => {
  it("uses /msg on IRC-style transports", () => {
    expect(dmCommandReference({ serverTag: "libera", mynick: "muaddib" }, "!balance"))
      .toBe("/msg muaddib !balance");
  });

  it("uses DM wording on Discord and Slack (no /msg there)", () => {
    expect(dmCommandReference({ serverTag: "discord:HomeGuild", mynick: "Muaddib" }, "!setkey"))
      .toBe("DM me: !setkey");
    expect(dmCommandReference({ serverTag: "slack:workspace", mynick: "muaddib" }, "!balance"))
      .toBe("DM me: !balance");
  });
});

import type { AssistantMessage, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

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

describe("extractThinking", () => {
  it("extracts a balanced block and returns the visible remainder", () => {
    const { text, thinking } = extractThinking(
      "<thinking>Directly invited by name.</thinking>eren, mefistofeles: the math holds.",
    );
    expect(text).toBe("eren, mefistofeles: the math holds.");
    expect(thinking).toBe("Directly invited by name.");
  });

  it("passes through text without thinking tags", () => {
    const { text, thinking } = extractThinking("plain answer");
    expect(text).toBe("plain answer");
    expect(thinking).toBe("");
  });

  it("joins multiple blocks and preserves surrounding text", () => {
    const { text, thinking } = extractThinking(
      "<thinking>one</thinking>visible <thinking>two</thinking>tail",
    );
    expect(text).toBe("visible tail");
    expect(thinking).toBe("one\ntwo");
  });

  it("swallows an unclosed <thinking> to end of text", () => {
    const { text, thinking } = extractThinking("<thinking>never closed reasoning");
    expect(text).toBe("");
    expect(thinking).toBe("never closed reasoning");
  });

  it("treats text before a stray </thinking> as reasoning continuation", () => {
    const { text, thinking } = extractThinking("continued reasoning</thinking>real answer");
    expect(text).toBe("real answer");
    expect(thinking).toBe("continued reasoning");
  });

  it("matches tag casing and inner whitespace variants", () => {
    const { text, thinking } = extractThinking(
      "<Thinking >secret stuff</ THINKING>answer",
    );
    expect(text).toBe("answer");
    expect(thinking).toBe("secret stuff");
  });
});

describe("extractStatus", () => {
  it("splits the status line from the rest of the message", () => {
    const { text, status, matched } = extractStatus("<status>Searching now.</status>\n\nkanzure: the answer.");
    expect(text).toBe("kanzure: the answer.");
    expect(status).toBe("Searching now.");
    expect(matched).toBe(true);
  });

  it("passes through text without status tags", () => {
    const { text, status, matched } = extractStatus("plain answer");
    expect(text).toBe("plain answer");
    expect(status).toBe("");
    expect(matched).toBe(false);
  });

  it("leaves an unclosed <status> alone and tolerates tag casing/whitespace", () => {
    // Never swallow to EOF: a lost answer is far worse than a visible tag.
    expect(extractStatus("<status>never closed")).toEqual({
      text: "<status>never closed",
      status: "",
      matched: false,
    });
    expect(extractStatus("< Status >working</ STATUS >done")).toEqual({
      text: "done",
      status: "working",
      matched: true,
    });
  });

  it("never swallows the answer preceding a stray </status>", () => {
    // Unlike <thinking>, a lone closer must not eat the real answer before it.
    expect(extractStatus("kanzure: the real answer</status>")).toEqual({
      text: "kanzure: the real answer</status>",
      status: "",
      matched: false,
    });
  });

  it("reports matched for empty tags so they get stripped rather than leak", () => {
    expect(extractStatus("<status></status>real answer")).toEqual({
      text: "real answer",
      status: "",
      matched: true,
    });
  });

  it("only honours a leading block, so mid-answer tags stay untouched", () => {
    const { text, status } = extractStatus("<status>one</status>body<status>two</status>");
    expect(text).toBe("body<status>two</status>");
    expect(status).toBe("one");
  });

  it("ignores a <status> that is not the leading block (e.g. quoted XML)", () => {
    const answer = "the field <status>pending</status> means the job is queued";
    expect(extractStatus(answer)).toEqual({ text: answer, status: "", matched: false });
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

describe("renderSteeredPassive", () => {
  const body = "[12:34] <alice> hello";

  it("after-assistant variant includes the NULL hint", () => {
    const text = renderSteeredPassive(body, { afterTool: false });
    expect(text).toContain("Background channel message");
    expect(text).toContain("respond with only the single word NULL");
    expect(text).toContain(body);
    expect(text).not.toContain("in-progress task");
  });

  it("after-tool variant emphasises continuing the in-progress task and omits the NULL hint", () => {
    const text = renderSteeredPassive(body, { afterTool: true });
    expect(text).toContain("in-progress task");
    expect(text).toContain("Continue your current tool work");
    expect(text).toContain(body);
    expect(text).not.toContain("NULL");
  });
});

describe("buildSteeredPassiveMessage", () => {
  it("produces a custom AgentMessage with the steered-passive type", () => {
    const m = buildSteeredPassiveMessage("hello");
    expect(m.role).toBe("custom");
    expect(m.customType).toBe(MUADDIB_STEERED_PASSIVE_CUSTOM_TYPE);
    expect(m.content).toBe("hello");
    expect(m.display).toBe(false);
    expect(typeof m.timestamp).toBe("number");
  });
});

describe("createSteeredPassiveAwareConvertToLlm", () => {
  const convert = createSteeredPassiveAwareConvertToLlm();

  function userMsg(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
  }

  function assistantMsg(text: string): AgentMessage {
    return makeAssistant([{ type: "text", text }]);
  }

  function toolResultMsg(): AgentMessage {
    return {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "output" }],
      isError: false,
      timestamp: 0,
    };
  }

  it("renders after-assistant variant when predecessor is an assistant message", async () => {
    const messages: AgentMessage[] = [
      userMsg("do something"),
      assistantMsg("sure"),
      buildSteeredPassiveMessage("[12:34] <alice> ping"),
    ];
    const out = await convert(messages);
    const last = out.at(-1) as { role: string; content: Array<{ type: string; text: string }> };
    expect(last.role).toBe("user");
    expect(last.content[0]?.text).toContain("respond with only the single word NULL");
    expect(last.content[0]?.text).toContain("[12:34] <alice> ping");
  });

  it("renders after-tool variant when predecessor is a toolResult", async () => {
    const messages: AgentMessage[] = [
      userMsg("run x"),
      assistantMsg("calling"),
      toolResultMsg(),
      buildSteeredPassiveMessage("[12:34] <alice> ping"),
    ];
    const out = await convert(messages);
    const last = out.at(-1) as { role: string; content: Array<{ type: string; text: string }> };
    expect(last.role).toBe("user");
    expect(last.content[0]?.text).toContain("Continue your current tool work");
    expect(last.content[0]?.text).not.toContain("NULL");
  });

  it("walks back past intervening user/custom messages to find the real predecessor", async () => {
    // Two batched steered passives + a synthetic user nudge between them and
    // the toolResult. Both must render as after-tool.
    const messages: AgentMessage[] = [
      userMsg("run x"),
      assistantMsg("calling"),
      toolResultMsg(),
      userMsg("<meta>ephemeral nudge</meta>"),
      buildSteeredPassiveMessage("[12:34] <alice> ping"),
      buildSteeredPassiveMessage("[12:35] <bob> pong"),
    ];
    const out = await convert(messages);
    const renderedSteers = out.slice(-2) as Array<{ content: Array<{ text: string }> }>;
    for (const m of renderedSteers) {
      expect(m.content[0]?.text).toContain("Continue your current tool work");
    }
  });

  it("defaults to after-assistant variant when there is no non-user predecessor", async () => {
    const messages: AgentMessage[] = [
      buildSteeredPassiveMessage("[12:34] <alice> ping"),
    ];
    const out = await convert(messages);
    const only = out[0] as { content: Array<{ text: string }> };
    expect(only.content[0]?.text).toContain("respond with only the single word NULL");
  });

  it("passes non-steered-passive messages through unchanged", async () => {
    const messages: AgentMessage[] = [
      userMsg("hi"),
      assistantMsg("hello"),
    ];
    const out = await convert(messages);
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
  });
});
