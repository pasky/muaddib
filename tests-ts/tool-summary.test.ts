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
              role: "toolResult",
              toolName: "web_search",
              details: {
                input: { query: "pi docs" },
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
  });
});
