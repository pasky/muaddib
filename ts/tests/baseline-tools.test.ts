import { describe, expect, it, vi } from "vitest";

import {
  createBaselineAgentTools,
  createProgressReportTool,
} from "../src/agent/tools/baseline-tools.js";

describe("baseline agent tools", () => {
  it("creates expected baseline tool names", () => {
    const tools = createBaselineAgentTools();
    expect(tools.map((tool) => tool.name)).toEqual([
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
});
