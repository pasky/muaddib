import { describe, expect, it, vi } from "vitest";

import {
  buildToolSummaryFollowUpPrompt,
  extractAssistantText,
  generateToolSummaryFromSession,
} from "../src/agent/tool-summary.js";
import { withCostSpan } from "../src/cost/cost-span.js";
import { LLM_CALL_TYPE } from "../src/cost/llm-call-type.js";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeUsage(input = 10, output = 5, cost = 0.01) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
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
      model: "openai:gpt-4o-mini",
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
      model: "openai:gpt-4o-mini",
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
        usage: makeUsage(11, 7, 0.02),
      });
    });

    const bumpSessionLimits = vi.fn();

    let summary: string | null = null;
    await withCostSpan("execute", { arc: "test-arc" }, async (span) => {
      summary = await generateToolSummaryFromSession({
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
        model: "openai:gpt-4o-mini",
      });

      expect(span.allEntries()).toMatchObject([
        {
          callType: LLM_CALL_TYPE.TOOL_SUMMARY,
          model: "openai:gpt-4o-mini",
          usage: { input: 11, output: 7, cost: { total: 0.02 } },
        },
      ]);
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
      model: "openai:gpt-4o-mini",
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

  it("can provide a distinct session_query id for shared-workdir nested sessions", () => {
    const prompt = buildToolSummaryFollowUpPrompt(["web_search"], { sessionQueryId: "session-abc12345/oracle-deadbeef" });

    expect(prompt).toContain("/workspace/.sessions/session-<slug>/ working directory paths");
    expect(prompt).toContain("Use session_query id `session-abc12345/oracle-deadbeef`");
    expect(prompt).toContain("working directory belongs to a parent command session");
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
