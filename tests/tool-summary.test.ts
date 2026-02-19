import { describe, expect, it, vi } from "vitest";

import { generateToolSummaryFromSession } from "../src/rooms/command/tool-summary.js";

describe("generateToolSummaryFromSession", () => {
  it("returns a summary for summary/artifact tools", async () => {
    const modelAdapter = {
      completeSimple: vi.fn(async () => ({
        content: [{ type: "text", text: "ran tool and produced artifact" }],
      })),
    } as any;

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const summary = await generateToolSummaryFromSession({
      result: {
        text: "ok",
        stopReason: "stop",
        usage: {} as any,
        session: {
          messages: [
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
              details: {
                query: "pi docs",
                artifactUrls: ["https://example.test/a"],
              },
            },
          ],
        },
      } as any,
      tools: [{ name: "web_search", persistType: "summary" }] as any,
      persistenceSummaryModel: "openai:gpt-4o-mini",
      modelAdapter,
      logger,
    });

    expect(summary).toBe("ran tool and produced artifact");
    expect(modelAdapter.completeSimple).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();

    // The prompt payload must include the real query arguments, not "undefined".
    const payload = modelAdapter.completeSimple.mock.calls[0][1];
    const userContent: string = payload.messages[0].content;
    expect(userContent).toContain("pi docs");
    expect(userContent).not.toContain('"input": undefined');
    expect(userContent).not.toMatch(/\bInput:\s*\nundefined/);
  });

  it("renders (unavailable) when toolCallId is absent from assistant messages", async () => {
    const modelAdapter = {
      completeSimple: vi.fn(async () => ({
        content: [{ type: "text", text: "searched something" }],
      })),
    } as any;

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await generateToolSummaryFromSession({
      result: {
        text: "ok",
        stopReason: "stop",
        usage: {} as any,
        session: {
          messages: [
            // No assistant message with matching toolCallId
            {
              role: "toolResult",
              toolCallId: "missing_call",
              toolName: "web_search",
              details: { query: "orphaned" },
            },
          ],
        },
      } as any,
      tools: [{ name: "web_search", persistType: "summary" }] as any,
      persistenceSummaryModel: "openai:gpt-4o-mini",
      modelAdapter,
      logger,
    });

    const payload = modelAdapter.completeSimple.mock.calls[0][1];
    const userContent: string = payload.messages[0].content;
    expect(userContent).toContain("(unavailable)");
    expect(userContent).not.toMatch(/\bInput:\s*\nundefined/);
  });
});
