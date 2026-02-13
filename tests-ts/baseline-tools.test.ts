import { describe, expect, it, vi } from "vitest";

import {
  createBaselineAgentTools,
  createChronicleAppendTool,
  createChronicleReadTool,
  createEditArtifactTool,
  createExecuteCodeTool,
  createGenerateImageTool,
  createOracleTool,
  createProgressReportTool,
  createQuestSnoozeTool,
  createQuestStartTool,
  createShareArtifactTool,
  createSubquestStartTool,
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
        generateImage: async () => ({ summaryText: "", images: [] }),
        oracle: async () => "",
        chronicleRead: async () => "",
        chronicleAppend: async () => "",
        questStart: async () => "",
        subquestStart: async () => "",
        questSnooze: async () => "",
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "web_search",
      "visit_webpage",
      "execute_code",
      "share_artifact",
      "edit_artifact",
      "generate_image",
      "oracle",
      "chronicle_read",
      "chronicle_append",
      "quest_start",
      "subquest_start",
      "quest_snooze",
      "progress_report",
      "make_plan",
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

  it("generate_image tool delegates to configured executor and returns text + image blocks", async () => {
    const generateImage = vi.fn(async () => ({
      summaryText: "Generated image: https://example.com/artifacts/?img.png",
      images: [
        {
          data: "aW1n",
          mimeType: "image/png",
          artifactUrl: "https://example.com/artifacts/?img.png",
        },
      ],
    }));
    const tool = createGenerateImageTool({ generateImage });

    const params = {
      prompt: "Draw a cat",
      image_urls: ["https://example.com/ref.png"],
    };

    const result = await tool.execute("call-7", params, undefined, undefined);

    expect(generateImage).toHaveBeenCalledWith(params);
    expect(result.content).toEqual([
      { type: "text", text: "Generated image: https://example.com/artifacts/?img.png" },
      { type: "image", data: "aW1n", mimeType: "image/png" },
    ]);
  });

  it("oracle tool delegates to configured executor", async () => {
    const oracle = vi.fn(async () => "Deep oracle answer");
    const tool = createOracleTool({ oracle });

    const params = {
      query: "How should I structure this migration?",
    };

    const result = await tool.execute("call-8", params, undefined, undefined);

    expect(oracle).toHaveBeenCalledWith(params);
    expect(result.content[0]).toEqual({ type: "text", text: "Deep oracle answer" });
  });

  it("chronicle tools delegate to configured executors", async () => {
    const chronicleRead = vi.fn(async () => "# Arc: test");
    const chronicleAppend = vi.fn(async () => "OK");

    const readTool = createChronicleReadTool({ chronicleRead });
    const appendTool = createChronicleAppendTool({ chronicleAppend });

    const readResult = await readTool.execute(
      "call-9",
      { relative_chapter_id: -1 },
      undefined,
      undefined,
    );
    const appendResult = await appendTool.execute(
      "call-10",
      { text: "Remember this." },
      undefined,
      undefined,
    );

    expect(chronicleRead).toHaveBeenCalledWith({ relative_chapter_id: -1 });
    expect(chronicleAppend).toHaveBeenCalledWith({ text: "Remember this." });
    expect(readResult.content[0]).toEqual({ type: "text", text: "# Arc: test" });
    expect(appendResult.content[0]).toEqual({ type: "text", text: "OK" });
  });

  it("quest tools delegate to configured executors", async () => {
    const questStart = vi.fn(async () => "Quest started");
    const subquestStart = vi.fn(async () => "Subquest started");
    const questSnooze = vi.fn(async () => "Quest snoozed");

    const questStartTool = createQuestStartTool({ questStart });
    const subquestStartTool = createSubquestStartTool({ subquestStart });
    const questSnoozeTool = createQuestSnoozeTool({ questSnooze });

    const startParams = {
      id: "migration-quest",
      goal: "Close parity gaps",
      success_criteria: "All tests pass",
    };

    const startResult = await questStartTool.execute("call-11", startParams, undefined, undefined);
    const subResult = await subquestStartTool.execute("call-12", startParams, undefined, undefined);
    const snoozeResult = await questSnoozeTool.execute(
      "call-13",
      { until: "14:30" },
      undefined,
      undefined,
    );

    expect(questStart).toHaveBeenCalledWith(startParams);
    expect(subquestStart).toHaveBeenCalledWith(startParams);
    expect(questSnooze).toHaveBeenCalledWith({ until: "14:30" });
    expect(startResult.content[0]).toEqual({ type: "text", text: "Quest started" });
    expect(subResult.content[0]).toEqual({ type: "text", text: "Subquest started" });
    expect(snoozeResult.content[0]).toEqual({ type: "text", text: "Quest snoozed" });
  });
});
