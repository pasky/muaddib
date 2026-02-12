import { describe, expect, it, vi } from "vitest";

import {
  createBaselineAgentTools,
  createEditArtifactTool,
  createExecuteCodeTool,
  createProgressReportTool,
  createShareArtifactTool,
  createVisitWebpageTool,
  createWebSearchTool,
} from "../src/agent/tools/baseline-tools.js";

describe("baseline agent tools", () => {
  it("creates expected baseline tool names", () => {
    const tools = createBaselineAgentTools({
      executors: {
        webSearch: async () => "",
        visitWebpage: async () => "",
        executeCode: async () => "",
        shareArtifact: async () => "",
        editArtifact: async () => "",
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "web_search",
      "visit_webpage",
      "execute_code",
      "share_artifact",
      "edit_artifact",
      "progress_report",
      "make_plan",
      "final_answer",
    ]);
  });

  it("progress_report tool invokes callback and returns text content", async () => {
    const onProgress = vi.fn(async () => {});
    const tool = createProgressReportTool({ onProgressReport: onProgress });

    const result = await tool.execute("call-1", { text: "working" }, undefined, undefined);

    expect(onProgress).toHaveBeenCalledWith("working");
    expect(result.content[0]).toEqual({ type: "text", text: "working" });
  });

  it("web_search tool delegates to configured executor", async () => {
    const webSearch = vi.fn(async (query: string) => `search:${query}`);
    const tool = createWebSearchTool({ webSearch });

    const result = await tool.execute("call-2", { query: "muaddib" }, undefined, undefined);

    expect(webSearch).toHaveBeenCalledWith("muaddib");
    expect(result.content[0]).toEqual({ type: "text", text: "search:muaddib" });
  });

  it("visit_webpage tool returns image content when executor returns image payload", async () => {
    const visitWebpage = vi.fn(async () => ({
      kind: "image" as const,
      data: "base64-image",
      mimeType: "image/png",
    }));
    const tool = createVisitWebpageTool({ visitWebpage });

    const result = await tool.execute("call-3", { url: "https://example.com/image.png" }, undefined, undefined);

    expect(visitWebpage).toHaveBeenCalledWith("https://example.com/image.png");
    expect(result.content[0]).toEqual({
      type: "image",
      data: "base64-image",
      mimeType: "image/png",
    });
  });

  it("execute_code tool delegates to configured executor and defaults language", async () => {
    const executeCode = vi.fn(async () => "execution-output");
    const tool = createExecuteCodeTool({ executeCode });

    const result = await tool.execute("call-4", { code: "print('hi')" }, undefined, undefined);

    expect(executeCode).toHaveBeenCalledWith({ code: "print('hi')" });
    expect(result.details.language).toBe("python");
    expect(result.content[0]).toEqual({ type: "text", text: "execution-output" });
  });

  it("share_artifact tool delegates to configured executor", async () => {
    const shareArtifact = vi.fn(async (content: string) => `Artifact shared: https://example.com/?${content.length}`);
    const tool = createShareArtifactTool({ shareArtifact });

    const result = await tool.execute("call-5", { content: "artifact body" }, undefined, undefined);

    expect(shareArtifact).toHaveBeenCalledWith("artifact body");
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Artifact shared: https://example.com/?13",
    });
  });

  it("edit_artifact tool delegates to configured executor", async () => {
    const editArtifact = vi.fn(async () => "Artifact edited successfully. New version: https://example.com/?next.py");
    const tool = createEditArtifactTool({ editArtifact });

    const params = {
      artifact_url: "https://example.com/?orig.py",
      old_string: "return 1",
      new_string: "return 2",
    };

    const result = await tool.execute("call-6", params, undefined, undefined);

    expect(editArtifact).toHaveBeenCalledWith(params);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Artifact edited successfully. New version: https://example.com/?next.py",
    });
  });
});
