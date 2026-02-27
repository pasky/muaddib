import { describe, expect, it, vi } from "vitest";

import { extractAssistantText, generateToolSummaryFromSession } from "../src/rooms/command/tool-summary.js";

describe("generateToolSummaryFromSession", () => {
  it("returns a summary for summary tools", async () => {
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

  it("strips base64 image data from visit_webpage output before summarizing", async () => {
    const modelAdapter = {
      completeSimple: vi.fn(async () => ({
        content: [{ type: "text", text: "visited an image page" }],
      })),
    } as any;

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const fakeBase64 = "iVBORw0KGgoAAAANSUh" + "A".repeat(500);

    await generateToolSummaryFromSession({
      result: {
        text: "ok",
        stopReason: "stop",
        usage: {} as any,
        session: {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call_img", name: "visit_webpage", arguments: { url: "https://example.test/photo.jpg" } },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "call_img",
              toolName: "visit_webpage",
              content: [
                { type: "image", data: fakeBase64, mimeType: "image/jpeg" },
              ],
              details: { url: "https://example.test/photo.jpg", kind: "image", mimeType: "image/jpeg" },
            },
          ],
        },
      } as any,
      tools: [{ name: "visit_webpage", persistType: "summary" }] as any,
      persistenceSummaryModel: "openai:gpt-4o-mini",
      modelAdapter,
      logger,
    });

    const payload = modelAdapter.completeSimple.mock.calls[0][1];
    const userContent: string = payload.messages[0].content;
    // The full base64 blob must NOT appear in the prompt
    expect(userContent).not.toContain(fakeBase64);
    // But we should still mention it was an image with a preview
    expect(userContent).toContain("[binary image data, image/jpeg]");
    // First 512 chars of the base64 should appear as preview
    expect(userContent).toContain(fakeBase64.slice(0, 512));
    expect(userContent).toContain("https://example.test/photo.jpg");
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

  it("includes memoryUpdateText in the summary input when provided", async () => {
    const modelAdapter = {
      completeSimple: vi.fn(async () => ({
        content: [{ type: "text", text: "summary with memory" }],
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
      persistenceSummaryModel: "openai:gpt-4o-mini",
      modelAdapter,
      logger,
      memoryUpdateText: "Updated MEMORY.md with new project preferences",
    });

    const payload = modelAdapter.completeSimple.mock.calls[0][1];
    const userContent: string = payload.messages[0].content;
    expect(userContent).toContain("Post-session memory update reasoning");
    expect(userContent).toContain("Updated MEMORY.md with new project preferences");
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
