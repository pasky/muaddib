import { beforeEach, describe, expect, it, vi } from "vitest";

import { PiAiModelAdapter } from "../src/models/pi-ai-model-adapter.js";
import {
  createBaselineAgentTools,
  createChronicleAppendTool,
  createChronicleReadTool,
  createGenerateImageTool,
  createOracleTool,
  ORACLE_EXCLUDED_TOOLS,
  createMakePlanTool,
  createProgressReportTool,
  createVisitWebpageTool,
  createWebSearchTool,
} from "../src/agent/tools/baseline-tools.js";
import { createShareArtifactTool } from "../src/agent/tools/artifact.js";
import {
  checkpointGondolinArc,
  createGondolinTools,
  getArcCheckpointPath,
  getArcWorkspacePath,
  isIpInCidr,
  normalizeArcId,
  resetGondolinVmCache,
} from "../src/agent/tools/gondolin-tools.js";

function createTools(options: Record<string, unknown>) {
  return createBaselineAgentTools({
    modelAdapter: new PiAiModelAdapter(),
    arc: "test-arc",
    ...(options as any),
  }).tools;
}

describe("baseline agent tools", () => {
  it("creates expected baseline tool names", () => {
    const tools = createTools({
      executors: {
        webSearch: async () => "",
        visitWebpage: async () => "",
        generateImage: async () => ({ summaryText: "", images: [] }),
        oracle: async () => "",
        chronicleRead: async () => "",
        chronicleAppend: async () => "",
      },
    });

    // Gondolin tools (read/write/edit/bash/share_artifact) are always included.
    expect(tools.map((tool) => tool.name)).toEqual([
      "web_search",
      "visit_webpage",
      "generate_image",
      "oracle",
      "chronicle_read",
      "chronicle_append",
      "read",
      "write",
      "edit",
      "bash",
      "share_artifact",
      "progress_report",
      "make_plan",
    ]);
  });

  it("every tool has a colocated persistType matching Python parity", () => {
    const tools = createTools({
      executors: {
        webSearch: async () => "",
        visitWebpage: async () => "",
        generateImage: async () => ({ summaryText: "", images: [] }),
        oracle: async () => "",
        chronicleRead: async () => "",
        chronicleAppend: async () => "",
      },
    });

    // Every tool must have a persistType
    for (const tool of tools) {
      expect((tool as any).persistType, `${tool.name} missing persistType`).toBeDefined();
    }
  });

  it("progress_report tool invokes callback and returns OK", async () => {
    const onProgress = vi.fn(async () => {});
    const tool = createProgressReportTool({ onProgressReport: onProgress });

    const result = await tool.execute("call-1", { text: "working" }, undefined, undefined);

    expect(onProgress).toHaveBeenCalledWith("working");
    expect(result.content[0]).toEqual({ type: "text", text: "OK" });
  });

  it("progress_report sanitizes whitespace to single line", async () => {
    const onProgress = vi.fn(async () => {});
    const tool = createProgressReportTool({ onProgressReport: onProgress });

    await tool.execute("call-1", { text: "  hello\n  world\t! " }, undefined, undefined);

    expect(onProgress).toHaveBeenCalledWith("hello world !");
  });

  it("progress_report rate-limits repeated calls", async () => {
    const onProgress = vi.fn(async () => {});
    const tool = createProgressReportTool({ onProgressReport: onProgress, minIntervalSeconds: 60 });

    const r1 = await tool.execute("call-1", { text: "first" }, undefined, undefined);
    expect(r1.content[0]).toEqual({ type: "text", text: "OK" });
    expect(onProgress).toHaveBeenCalledTimes(1);

    const r2 = await tool.execute("call-2", { text: "second" }, undefined, undefined);
    expect((r2.content[0] as { text: string }).text).toMatch(/rate-limited/);
    expect(r2.details.rateLimited).toBe(true);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("progress_report returns OK for empty text without calling callback", async () => {
    const onProgress = vi.fn(async () => {});
    const tool = createProgressReportTool({ onProgressReport: onProgress });

    const result = await tool.execute("call-1", { text: "   " }, undefined, undefined);

    expect(result.content[0]).toEqual({ type: "text", text: "OK" });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("make_plan tool returns OK and stores plan details", async () => {
    const tool = createMakePlanTool();

    const result = await tool.execute("call-1", { plan: "Step 1: research. Step 2: execute." }, undefined, undefined);

    expect(result.content[0]).toEqual({ type: "text", text: "OK, follow this plan" });
    expect(result.details.plan).toBe("Step 1: research. Step 2: execute.");
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

  it("share_artifact tool delegates to configured executor with file_path", async () => {
    const shareArtifact = vi.fn(async (_input: { file_path: string }) => `Artifact shared: https://example.com/?report.csv`);
    const tool = createShareArtifactTool({ shareArtifact });

    const result = await tool.execute("call-5", { file_path: "/workspace/report.csv" }, undefined, undefined);

    expect(shareArtifact).toHaveBeenCalledWith({ file_path: "/workspace/report.csv" });
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Artifact shared: https://example.com/?report.csv",
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
    const tool = createGenerateImageTool({ generateImage }, "openrouter:google/gemini-2-flash-exp");

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

  it("generate_image tool description includes configured model ID", () => {
    const tool = createGenerateImageTool({ generateImage: async () => ({ summaryText: "", images: [] }) }, "openrouter:google/gemini-2-flash-exp");
    expect(tool.description).toContain("openrouter:google/gemini-2-flash-exp");
  });

  it("generate_image tool description falls back gracefully when no model ID given", () => {
    const tool = createGenerateImageTool({ generateImage: async () => ({ summaryText: "", images: [] }) });
    expect(tool.description).not.toContain("tools.imageGen.model");
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

  it("oracle tool description mentions complex analysis and creative work", () => {
    const tool = createOracleTool({ oracle: async () => "" });
    expect(tool.description).toContain("complex analysis");
    expect(tool.description).toContain("creative work");
  });

  it("ORACLE_EXCLUDED_TOOLS prevents recursion and irrelevant nested tools", () => {
    expect(ORACLE_EXCLUDED_TOOLS).toContain("oracle");
    expect(ORACLE_EXCLUDED_TOOLS).toContain("progress_report");
    // Useful tools should NOT be excluded
    expect(ORACLE_EXCLUDED_TOOLS).not.toContain("web_search");
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

});

// ── Gondolin tool set ──────────────────────────────────────────────────────

describe("baseline tools with Gondolin", () => {
  it("always includes read/write/edit/bash and share_artifact", () => {
    const { tools } = createBaselineAgentTools({
      modelAdapter: new PiAiModelAdapter(),
      arc: "test-arc",
    } as any);
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).toContain("bash");
    expect(names).toContain("share_artifact");
    expect(names).not.toContain("execute_code");
  });

  it("includes all baseline tools alongside gondolin tools", () => {
    const { tools } = createBaselineAgentTools({
      modelAdapter: new PiAiModelAdapter(),
      arc: "test-arc",
    } as any);
    const names = tools.map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("visit_webpage");
    expect(names).toContain("generate_image");
    expect(names).toContain("oracle");
    expect(names).toContain("chronicle_read");
    expect(names).toContain("chronicle_append");
    expect(names).toContain("progress_report");
    expect(names).toContain("make_plan");
  });

  it("rejects deprecated dnsMode=trusted", () => {
    expect(() => createBaselineAgentTools({
      modelAdapter: new PiAiModelAdapter(),
      arc: "test-arc",
      toolsConfig: { gondolin: { dnsMode: "trusted" } },
    } as any)).toThrow(/dnsMode.*trusted/i);
  });

  it("always returns dispose function", () => {
    const { dispose } = createBaselineAgentTools({
      modelAdapter: new PiAiModelAdapter(),
      arc: "test-arc",
    } as any);
    expect(typeof dispose).toBe("function");
  });
});

// ── Gondolin checkpoint path ───────────────────────────────────────────────

describe("getArcCheckpointPath", () => {
  it("checkpoint path is under checkpoints/ not workspaces/", () => {
    const checkpointPath = getArcCheckpointPath("test-arc");
    expect(checkpointPath).toContain("/checkpoints/");
    expect(checkpointPath).not.toContain("/workspaces/");
  });

  it("checkpoint path ends with .qcow2", () => {
    expect(getArcCheckpointPath("test-arc")).toMatch(/\.qcow2$/);
  });

  it("checkpoint path is not inside the workspace directory", () => {
    const arc = "test-arc";
    const checkpointPath = getArcCheckpointPath(arc);
    const workspacePath = getArcWorkspacePath(arc);
    expect(checkpointPath.startsWith(workspacePath)).toBe(false);
  });

  it("checkpoint filename contains the arc hash", () => {
    const arc = "test-arc";
    const arcId = normalizeArcId(arc);
    expect(getArcCheckpointPath(arc)).toContain(arcId);
  });

  it("different arcs produce different checkpoint paths", () => {
    expect(getArcCheckpointPath("arc-one")).not.toBe(getArcCheckpointPath("arc-two"));
  });
});

// ── Gondolin network filtering helpers ────────────────────────────────────

describe("isIpInCidr", () => {
  it("matches IPv4 address in /24 range", () => {
    expect(isIpInCidr("192.168.1.5", "192.168.1.0/24")).toBe(true);
  });

  it("does not match IPv4 address outside /24 range", () => {
    expect(isIpInCidr("192.168.2.5", "192.168.1.0/24")).toBe(false);
  });

  it("matches IPv4 exact host /32", () => {
    expect(isIpInCidr("10.0.0.1", "10.0.0.1/32")).toBe(true);
  });

  it("matches IPv6 address in /64 range", () => {
    expect(isIpInCidr("2001:db8:1:2::dead:beef", "2001:db8:1:2::/64")).toBe(true);
  });

  it("does not match IPv6 address outside /64 range", () => {
    expect(isIpInCidr("2001:db8:1:3::dead:beef", "2001:db8:1:2::/64")).toBe(false);
  });

  it("matches IPv6 compressed :: notation in prefix", () => {
    expect(isIpInCidr("::1", "::1/128")).toBe(true);
  });

  it("does not cross-match IPv4 CIDR against IPv6 address", () => {
    expect(isIpInCidr("2001:db8::1", "192.168.0.0/16")).toBe(false);
  });

  it("rejects non-numeric CIDR prefix length", () => {
    expect(isIpInCidr("192.168.1.5", "192.168.1.0/x")).toBe(false);
  });

  it("rejects negative CIDR prefix length", () => {
    expect(isIpInCidr("192.168.1.5", "192.168.1.0/-1")).toBe(false);
  });

  it("rejects out-of-range IPv4 CIDR prefix length", () => {
    expect(isIpInCidr("192.168.1.5", "192.168.1.0/33")).toBe(false);
  });

  it("rejects out-of-range IPv6 CIDR prefix length", () => {
    expect(isIpInCidr("2001:db8:1:2::dead:beef", "2001:db8:1:2::/129")).toBe(false);
  });
});

// ── Gondolin session ref-counting ──────────────────────────────────────────

describe("gondolin session ref-counting", () => {
  const gondolinConfig = {};

  beforeEach(() => {
    resetGondolinVmCache();
  });

  it("defers checkpoint while a second session is still active", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    createGondolinTools({ arc: "test-arc", config: gondolinConfig, logger });
    createGondolinTools({ arc: "test-arc", config: gondolinConfig, logger });

    // First session ends — one still active, should defer
    await checkpointGondolinArc("test-arc", logger);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("1 session(s) still active"),
    );
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("checkpointed"));
  });

  it("proceeds to checkpoint when the last session ends (no VM in cache = no-op)", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    createGondolinTools({ arc: "test-arc", config: gondolinConfig, logger });

    // Only session ends — should not defer (no VM cached, so returns early after counter hits 0)
    await checkpointGondolinArc("test-arc", logger);

    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("still active"),
    );
  });

  it("counts sessions per arc independently", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    createGondolinTools({ arc: "arc-one", config: gondolinConfig, logger });
    createGondolinTools({ arc: "arc-two", config: gondolinConfig, logger });

    // arc-one's only session ends — should not defer for arc-one
    await checkpointGondolinArc("arc-one", logger);
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining("still active"));

    // arc-two's only session ends — should also not defer
    await checkpointGondolinArc("arc-two", logger);
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining("still active"));
  });

  // ── Issue #3: oracle nested sessions create and balance Gondolin refcounts ──

  it("oracle-style nested session: parent + oracle both increment, both checkpoints needed", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // Parent command session opens Gondolin (refcount = 1)
    createGondolinTools({ arc: "test-arc", config: gondolinConfig, logger });
    // Oracle nested session also opens Gondolin for the same arc (refcount = 2)
    createGondolinTools({ arc: "test-arc", config: gondolinConfig, logger });

    // Oracle finishes and calls checkpointGondolinArc — should defer (parent still active)
    await checkpointGondolinArc("test-arc", logger);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("1 session(s) still active"),
    );

    // Parent finishes and calls checkpointGondolinArc — refcount hits 0, checkpoint triggered
    await checkpointGondolinArc("test-arc", logger);
    // No deferred log for the second call (no more active sessions)
    const deferCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => typeof args[0] === "string" && args[0].includes("still active"),
    );
    expect(deferCalls).toHaveLength(1); // Only the first oracle call deferred
  });

  // ── Issue #2: extra checkpoint call (e.g. error path) warns, doesn't corrupt state ──

  it("extra checkpointGondolinArc call (more than createGondolinTools) warns and is a no-op", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    createGondolinTools({ arc: "test-arc", config: gondolinConfig, logger });

    // Normal checkpoint call — balances the one createGondolinTools above
    await checkpointGondolinArc("test-arc", logger);

    // Extra call (simulates a finally block running after a prior success-path checkpoint)
    await checkpointGondolinArc("test-arc", logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("checkpointGondolinArc called with no active sessions"),
    );
    // Should not throw and should not attempt to checkpoint again
    expect(logger.error).not.toHaveBeenCalled();
  });
});
