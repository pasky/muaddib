import { describe, expect, it, vi } from "vitest";

import {
  buildToolSummaryFollowUpPrompt,
  generateToolSummaryFromSession,
} from "../src/agent/tool-summary.js";
import { currentCostSpan, withCostSpan } from "../src/cost/cost-span.js";
import { LLM_CALL_TYPE } from "../src/cost/llm-call-type.js";

/**
 * A session whose append-only branch holds the given messages. `live` is what
 * session.messages currently shows; compaction may have truncated it.
 */
function sessionWith(branch: unknown[], live: unknown[] = branch) {
  return {
    messages: live,
    sessionManager: { getBranch: () => branch.map((message) => ({ type: "message", message })) },
  };
}

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
    const followUp = vi.fn();

    const summary = await generateToolSummaryFromSession({
      result: {
        text: "ok",
        stopReason: "stop",
        usage: {} as any,
        followUp,
        session: sessionWith([
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
        ]),
      } as any,
      tools: [{ name: "read", persistType: "none" }] as any,
      logger,
    });

    expect(summary).toBeNull();
    expect(followUp).not.toHaveBeenCalled();
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

    // The runner's followUp records its usage under whatever cost span is
    // current, so the summary must run inside a TOOL_SUMMARY span.
    let followUpSpanName: string | undefined;
    const followUp = vi.fn(async () => {
      followUpSpanName = currentCostSpan()?.name;
      return "ran tool and produced artifact";
    });

    const summary = await withCostSpan("execute", { arc: "test-arc" }, async () =>
      await generateToolSummaryFromSession({
        result: {
          text: "ok",
          stopReason: "stop",
          usage: {} as any,
          followUp,
          // Compaction has truncated the live message list; the tool results
          // only survive in the session branch, and that must be enough.
          session: sessionWith(sessionMessages, []),
        } as any,
        tools: [
          { name: "web_search", persistType: "summary" },
          { name: "read", persistType: "none" },
        ] as any,
        logger,
      }));

    expect(summary).toBe("ran tool and produced artifact");
    expect(followUp).toHaveBeenCalledOnce();
    expect(followUp).toHaveBeenCalledWith(
      buildToolSummaryFollowUpPrompt(["web_search"]),
    );
    expect(followUpSpanName).toBe(LLM_CALL_TYPE.TOOL_SUMMARY);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("returns null when in-session follow-up prompt fails", async () => {
    const logger = makeLogger();

    const summary = await generateToolSummaryFromSession({
      result: {
        text: "ok",
        stopReason: "stop",
        usage: {} as any,
        followUp: vi.fn(async () => {
          throw new Error("boom");
        }),
        session: sessionWith([
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
        ]),
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

  it("can provide a distinct session_query id for shared-workdir nested sessions", () => {
    const prompt = buildToolSummaryFollowUpPrompt(["web_search"], { sessionQueryId: "session-abc12345/oracle-deadbeef" });

    expect(prompt).toContain("/workspace/.sessions/session-<slug>/ working directory paths");
    expect(prompt).toContain("Use session_query id `session-abc12345/oracle-deadbeef`");
    expect(prompt).toContain("working directory belongs to a parent command session");
  });
});
