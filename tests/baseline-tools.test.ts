import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PiAiModelAdapter } from "../src/models/pi-ai-model-adapter.js";
import {
  createBaselineAgentTools,
  createGenerateImageTool,
  createOracleTool,
  createDeepResearchTool,
  ORACLE_EXCLUDED_TOOLS,
  createMakePlanTool,
  createRequestNetworkAccessTool,
  createVisitWebpageTool,
  createWebSearchTool,
} from "../src/agent/tools/baseline-tools.js";
import { createShareArtifactTool } from "../src/agent/tools/artifact.js";
import { createGondolinTools } from "../src/agent/tools/gondolin-tools.js";
import {
  checkpointGondolinArc,
  getArcWorkspacePath,
} from "../src/agent/gondolin/index.js";
import { getArcCheckpointPath } from "../src/agent/gondolin/fs.js";
import { createVmHttpHooks, isIpInCidr } from "../src/agent/gondolin/network.js";
import { resetGondolinVmCache } from "../src/agent/gondolin/vm.js";
import {
  NETWORK_TRUST_TTL_MS,
  canonicalizeNetworkTrustUrl,
  getArcNetworkTrustLedgerPath,
  isUrlTrustedInArc,
  recordNetworkTrustEvent,
} from "../src/agent/network-boundary.js";
import { NetworkBoundaryService } from "../src/agent/network-boundary-service.js";
import { buildArc } from "../src/rooms/message.js";

const tempDirs: string[] = [];
const originalMuaddibHome = process.env.MUADDIB_HOME;

function createTools(options: Record<string, unknown>) {
  return createBaselineAgentTools({
    modelAdapter: new PiAiModelAdapter(),
    authStorage: AuthStorage.inMemory(),
    arc: "test-arc",
    ...(options as any),
  }).tools;
}

async function trustUrl(url: string, arc = "test-arc", now = new Date()): Promise<void> {
  await recordNetworkTrustEvent(arc, {
    source: "approval",
    rawUrl: url,
  }, now);
}

beforeEach(async () => {
  const muaddibHome = await mkdtemp(join(tmpdir(), "muaddib-baseline-tools-"));
  tempDirs.push(muaddibHome);
  process.env.MUADDIB_HOME = muaddibHome;
});

afterEach(async () => {
  process.env.MUADDIB_HOME = originalMuaddibHome;
  resetGondolinVmCache();
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("baseline agent tools", () => {
  it("creates expected baseline tool names", () => {
    const tools = createTools({
      executors: {
        webSearch: async () => "",
        visitWebpage: async () => "",
        generateImage: async () => ({ summaryText: "", images: [] }),
        oracle: async () => "",
        deepResearch: async () => "",
      },
    });

    // Gondolin tools (read/write/edit/bash/share_artifact) are always included.
    expect(tools.map((tool) => tool.name)).toEqual([
      "web_search",
      "visit_webpage",
      "request_network_access",
      "generate_image",
      "oracle",
      "deep_research",
      "read",
      "write",
      "edit",
      "bash",
      "share_artifact",
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
        deepResearch: async () => "",
      },
    });

    // Every tool must have a persistType
    for (const tool of tools) {
      expect((tool as any).persistType, `${tool.name} missing persistType`).toBeDefined();
    }
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

    expect(visitWebpage).toHaveBeenCalledWith("https://example.com/image.png", undefined);
    expect(result.content[0]).toEqual({
      type: "image",
      data: "base64-image",
      mimeType: "image/png",
    });
  });

  it("request_network_access tool delegates to configured executor", async () => {
    const requestNetworkAccess = vi.fn(async (input: { url: string; reason?: string }) => `approved:${input.url}`);
    const tool = createRequestNetworkAccessTool({ requestNetworkAccess });

    const result = await tool.execute(
      "call-4",
      { url: "https://example.com/docs?page=1", reason: "Need documentation" },
      undefined,
      undefined,
    );

    expect(requestNetworkAccess).toHaveBeenCalledWith({
      url: "https://example.com/docs?page=1",
      reason: "Need documentation",
    });
    expect(result.content[0]).toEqual({ type: "text", text: "approved:https://example.com/docs?page=1" });
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
    expect(tool.description).toContain("very short one-line note");
  });

  it("oracle tool description includes configured model ID", () => {
    const tool = createOracleTool({ oracle: async () => "" }, "anthropic:claude-sonnet-4");
    expect(tool.description).toContain("anthropic:claude-sonnet-4");
  });

  it("oracle tool description omits model clause when no model ID given", () => {
    const tool = createOracleTool({ oracle: async () => "" });
    expect(tool.description).not.toContain("using");
    expect(tool.description).toMatch(/^Consult the oracle -/);
  });

  it("ORACLE_EXCLUDED_TOOLS prevents recursion and irrelevant nested tools", () => {
    expect(ORACLE_EXCLUDED_TOOLS).toContain("oracle");
    expect(ORACLE_EXCLUDED_TOOLS).toContain("deep_research");
    // Useful tools should NOT be excluded
    expect(ORACLE_EXCLUDED_TOOLS).not.toContain("web_search");
  });

  it("deep_research tool delegates to configured executor", async () => {
    const deepResearch = vi.fn(async () => "Research findings");
    const tool = createDeepResearchTool({ deepResearch });

    const params = {
      query: "What are the latest developments in quantum computing?",
    };

    const result = await tool.execute("call-9", params, undefined, undefined);

    expect(deepResearch).toHaveBeenCalledWith(params);
    expect(result.content[0]).toEqual({ type: "text", text: "Research findings" });
  });

  it("deep_research tool description mentions web tools and advisory nature", () => {
    const tool = createDeepResearchTool({ deepResearch: async () => "" });
    expect(tool.description).toContain("web_search");
    expect(tool.description).toContain("may require an additional validation");
  });

  it("deep_research tool description includes configured model ID", () => {
    const tool = createDeepResearchTool({ deepResearch: async () => "" }, "openrouter:google/gemini-3-flash");
    expect(tool.description).toContain("openrouter:google/gemini-3-flash");
  });

  it("deep_research tool description omits model clause when no model ID given", () => {
    const tool = createDeepResearchTool({ deepResearch: async () => "" });
    expect(tool.description).not.toContain("using");
    expect(tool.description).toMatch(/^Launch a web researcher\s+-/);
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
    expect(names).toContain("request_network_access");
    expect(names).toContain("generate_image");
    expect(names).toContain("oracle");
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

// ── buildArc (percent-encoding) ────────────────────────────────────────────

describe("buildArc", () => {
  it("passes through simple arc names unchanged", () => {
    expect(buildArc("irc-libera", "general")).toBe("irc-libera#general");
  });

  it("encodes slashes as %2F", () => {
    expect(buildArc("irc-libera", "foo/bar")).toBe("irc-libera#foo%2Fbar");
  });

  it("encodes percent signs as %25 before encoding slashes", () => {
    expect(buildArc("arc%2F", "x")).toBe("arc%252F#x");
  });

  it("handles multiple slashes and percents", () => {
    expect(buildArc("a/b%c", "d")).toBe("a%2Fb%25c#d");
  });

  it("different arcs produce different ids (no collisions)", () => {
    // "foo/bar#x" and "foo%2Fbar#x" must not collide
    expect(buildArc("foo/bar", "x")).not.toBe(buildArc("foo%2Fbar", "x"));
  });
});

// ── Gondolin checkpoint path ───────────────────────────────────────────────

describe("getArcCheckpointPath", () => {
  it("checkpoint path is under arcs/<arc>/ not workspaces/", () => {
    const checkpointPath = getArcCheckpointPath("test-arc");
    expect(checkpointPath).toContain("/arcs/test-arc/checkpoint.qcow2");
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

  it("checkpoint filename contains the arc id", () => {
    const arc = "test-arc";
    expect(getArcCheckpointPath(arc)).toContain(arc);
  });

  it("different arcs produce different checkpoint paths", () => {
    expect(getArcCheckpointPath("arc-one")).not.toBe(getArcCheckpointPath("arc-two"));
  });
});

// ── Shared network boundary module ────────────────────────────────────────

describe("network boundary shared module", () => {
  it("canonicalizes URLs per the design doc", () => {
    expect(canonicalizeNetworkTrustUrl("https://Example.com/foo?a=1#x")).toBe("https://example.com/foo");
    expect(canonicalizeNetworkTrustUrl("https://example.com/foo?a=2")).toBe("https://example.com/foo");
    expect(canonicalizeNetworkTrustUrl("https://example.com")).toBe("https://example.com/");
    expect(canonicalizeNetworkTrustUrl("https://example.com:443/docs")).toBe("https://example.com/docs");
    expect(canonicalizeNetworkTrustUrl("http://Example.com:8080")).toBe("http://example.com:8080/");
  });

  it("stores trust per arc and expires entries after 30 days", async () => {
    const now = new Date("2026-03-09T12:00:00.000Z");

    await recordNetworkTrustEvent("arc-one", {
      source: "approval",
      rawUrl: "https://example.com/path?token=x",
    }, now);

    expect(await isUrlTrustedInArc("arc-one", "https://example.com/path?other=1", now)).toBe(true);
    expect(await isUrlTrustedInArc("arc-two", "https://example.com/path", now)).toBe(false);
    expect(
      await isUrlTrustedInArc(
        "arc-one",
        "https://example.com/path",
        new Date(now.getTime() + NETWORK_TRUST_TTL_MS - 1_000),
      ),
    ).toBe(true);
    expect(
      await isUrlTrustedInArc(
        "arc-one",
        "https://example.com/path",
        new Date(now.getTime() + NETWORK_TRUST_TTL_MS + 1_000),
      ),
    ).toBe(false);

    const ledger = await readFile(getArcNetworkTrustLedgerPath("arc-one"), "utf-8");
    expect(ledger).toContain('"source":"approval"');
    expect(ledger).toContain('"canonicalUrl":"https://example.com/path"');
  });

  it("requestAccess auto-approves matching gondolin arc regexes", async () => {
    const service = new NetworkBoundaryService();

    const result = await service.requestAccess(
      {
        arc: "service-arc",
        serverTag: "slack:Corp",
        channelName: "#release",
        gondolinConfig: {
          arcs: {
            "slack:Corp##release": {
              urlAllowRegexes: ["^https://example\\.com/.*$"],
            },
          },
        },
      },
      {
        url: "https://Example.com/docs?page=1",
        reason: "Need docs",
      },
    );

    expect(result).toEqual({
      canonicalUrl: "https://example.com/docs",
      approved: true,
      autoApproved: true,
      message: "Network access auto-approved by config for https://example.com/docs.",
    });
    expect(await isUrlTrustedInArc("service-arc", "https://example.com/docs?section=2")).toBe(true);
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

describe("createVmHttpHooks network trust policy", () => {
  it("allows only trusted canonical URLs for sandbox HTTP requests", async () => {
    const { httpHooks } = await createVmHttpHooks({
      arc: "sandbox-arc",
      blockedCidrs: [],
    });

    expect(
      await Promise.resolve(httpHooks.isRequestAllowed?.(new Request("https://example.com/path?x=1"))),
    ).toBe(false);

    await trustUrl("https://example.com/path?seed=1", "sandbox-arc");

    expect(
      await Promise.resolve(httpHooks.isRequestAllowed?.(new Request("https://example.com/path?x=2", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }))),
    ).toBe(true);
  });

  it("auto-approves sandbox HTTP requests matching configured regexes", async () => {
    const { httpHooks } = await createVmHttpHooks({
      arc: "sandbox-allow-arc",
      blockedCidrs: [],
      autoApproveRegexes: [/^https:\/\/example\.com\/allowed$/u],
    });

    expect(
      await Promise.resolve(httpHooks.isRequestAllowed?.(new Request("https://Example.com/allowed?token=1"))),
    ).toBe(true);
    expect(await isUrlTrustedInArc("sandbox-allow-arc", "https://example.com/allowed?x=2")).toBe(true);
  });

  it("auto-trusts redirect targets for sandbox direct network", async () => {
    await trustUrl("https://source.example.com/start?token=1", "redirect-arc");

    const upstreamFetch = vi.fn(async () => new Response("", {
      status: 302,
      headers: {
        location: "https://cdn.example.com/final?download=1",
      },
    }));

    const { fetch: trustAwareFetch, httpHooks } = await createVmHttpHooks({
      arc: "redirect-arc",
      blockedCidrs: [],
      fetchImpl: upstreamFetch as any,
    });

    await trustAwareFetch("https://source.example.com/start?token=1", {
      method: "GET",
      redirect: "manual",
    });

    expect(await isUrlTrustedInArc("redirect-arc", "https://cdn.example.com/final?other=1")).toBe(true);
    expect(
      await Promise.resolve(httpHooks.isRequestAllowed?.(new Request("https://cdn.example.com/final?other=2"))),
    ).toBe(true);
  });
});

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
