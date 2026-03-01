import { describe, expect, it, vi } from "vitest";

import {
  buildToolSummaryFollowUpPrompt,
  extractAssistantText,
  generateToolSummaryFromSession,
} from "../src/rooms/command/tool-summary.js";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("generateToolSummaryFromSession", () => {
  it("returns null when session is missing", async () => {
    const logger = makeLogger();

    const summary = await generateToolSummaryFromSession({
      result: {
        text: "ok",
        stopReason: "stop",
        usage: {} as any,
      } as any,
      tools: [{ name: "web_search", persistType: "summary" }] as any,
      logger,
    });

    expect(summary).toBeNull();
  });

  it("returns null when no summary tool results were produced", async () => {
    const logger = makeLogger();
    const promptSpy = vi.fn();

    const summary = await generateToolSummaryFromSession({
      result: {
        text: "ok",
        stopReason: "stop",
        usage: {} as any,
        session: {
          prompt: promptSpy,
          messages: [
            {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp/test" } },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "read",
              details: {},
            },
          ],
        },
      } as any,
      tools: [{ name: "read", persistType: "none" }] as any,
      logger,
    });

    expect(summary).toBeNull();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("generates an in-session follow-up summary", async () => {
    const logger = makeLogger();
    const sessionMessages: any[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "web_search", arguments: { query: "pi docs" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "web_search",
        details: { query: "pi docs" },
      },
    ];

    const promptSpy = vi.fn(async () => {
      sessionMessages.push({
        role: "assistant",
        content: [{ type: "text", text: "ran tool and produced artifact" }],
      });
    });

    const bumpSessionLimits = vi.fn();

    const summary = await generateToolSummaryFromSession({
      result: {
        text: "ok",
        stopReason: "stop",
        usage: {
          input: 120,
          output: 20,
          cacheRead: 30,
          cacheWrite: 10,
          totalTokens: 180,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
        },
        bumpSessionLimits,
        session: {
          prompt: promptSpy,
          messages: sessionMessages,
        },
      } as any,
      tools: [
        { name: "web_search", persistType: "summary" },
        { name: "read", persistType: "none" },
      ] as any,
      logger,
    });

    expect(summary).toBe("ran tool and produced artifact");
    expect(promptSpy).toHaveBeenCalledOnce();
    expect(promptSpy).toHaveBeenCalledWith(
      buildToolSummaryFollowUpPrompt(["web_search"]),
    );
    expect(bumpSessionLimits).toHaveBeenCalledWith(16, 0.05);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("returns null when in-session follow-up prompt fails", async () => {
    const logger = makeLogger();

    const summary = await generateToolSummaryFromSession({
      result: {
        text: "ok",
        stopReason: "stop",
        usage: {} as any,
        session: {
          prompt: vi.fn(async () => {
            throw new Error("boom");
          }),
          messages: [
            {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "bash",
              details: {},
            },
          ],
        },
      } as any,
      tools: [{ name: "bash", persistType: "summary" }] as any,
      logger,
    });

    expect(summary).toBeNull();
    expect(logger.error).toHaveBeenCalledWith("In-session tool summary failed", expect.any(Error));
  });
});

describe("buildToolSummaryFollowUpPrompt", () => {
  it("includes provided summary tool names in the prompt", () => {
    const prompt = buildToolSummaryFollowUpPrompt(["web_search", "bash"]);

    expect(prompt).toContain("<meta>Session complete. DO NOT RESPOND ANYMORE.");
    expect(prompt).toContain("web_search, bash");
    expect(prompt).toContain("Do NOT use any tools");
    expect(prompt).toContain("</meta>");
  });
});

describe("extractAssistantText", () => {
  it("extracts text blocks from assistant messages", () => {
    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will update memory." },
          { type: "toolCall", id: "c1", name: "write", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "c1", toolName: "write" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done updating." }],
      },
    ] as any[];
    expect(extractAssistantText(messages)).toBe("I will update memory.\nDone updating.");
  });

  it("returns undefined for empty or non-assistant messages", () => {
    expect(extractAssistantText([])).toBeUndefined();
    expect(extractAssistantText([{ role: "user", content: "hello" }] as any[])).toBeUndefined();
  });
});
