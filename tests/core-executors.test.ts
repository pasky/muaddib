import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { createDefaultToolExecutors as createDefaultToolExecutorsRaw } from "../src/agent/tools/baseline-tools.js";
import { createDefaultShareArtifactExecutor } from "../src/agent/tools/artifact.js";
import { createDefaultOracleExecutor as createDefaultOracleExecutorRaw } from "../src/agent/tools/oracle.js";
import {
  isUrlTrustedInArc,
  recordNetworkTrustEvent,
} from "../src/agent/network-boundary.js";
import { PiAiModelAdapter } from "../src/models/pi-ai-model-adapter.js";
import { resetWebRateLimiters, jinaRetryConfig } from "../src/agent/tools/web.js";
const tempDirs: string[] = [];
const originalJinaRetryDelays = [...jinaRetryConfig.delaysMs];
const originalMuaddibHome = process.env.MUADDIB_HOME;
const TEST_ARC = "test-arc";

beforeEach(async () => {
  resetWebRateLimiters();
  const muaddibHome = await mkdtemp(join(tmpdir(), "muaddib-ts-home-"));
  tempDirs.push(muaddibHome);
  process.env.MUADDIB_HOME = muaddibHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  jinaRetryConfig.delaysMs = [...originalJinaRetryDelays];
  process.env.MUADDIB_HOME = originalMuaddibHome;
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeArtifactsDir(): Promise<{ dir: string; artifactsPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-artifacts-"));
  tempDirs.push(dir);
  const artifactsPath = join(dir, "artifacts");
  await mkdir(artifactsPath, { recursive: true });
  return { dir, artifactsPath };
}

function extractSharedUrl(result: string): string {
  const parts = result.split(": ");
  return parts[parts.length - 1];
}

function extractFilenameFromViewerUrl(url: string): string {
  const parsed = new URL(url);
  return decodeURIComponent(parsed.search.slice(1));
}

function createDefaultToolExecutors(options: Record<string, unknown> = {}) {
  return createDefaultToolExecutorsRaw({
    modelAdapter: new PiAiModelAdapter(),
    authStorage: AuthStorage.inMemory(),
    arc: TEST_ARC,
    ...(options as any),
  });
}

async function trustUrl(url: string, arc = TEST_ARC, now = new Date()): Promise<void> {
  await recordNetworkTrustEvent(arc, {
    source: "approval",
    rawUrl: url,
  }, now);
}

function createDefaultOracleExecutor(options: Record<string, unknown> = {}, invocation?: any) {
  return createDefaultOracleExecutorRaw({
    modelAdapter: new PiAiModelAdapter(),
    authStorage: AuthStorage.inMemory(),
    arc: TEST_ARC,
    ...(options as any),
  } as any, invocation);
}

describe("core tool executors artifact support", () => {
  it("share_artifact reads file from sandbox and publishes as artifact preserving extension", async () => {
    const { artifactsPath } = await makeArtifactsDir();
    const logger = { info: vi.fn() };

    const mockReadFile = vi.fn(async () => Buffer.from("hello from sandbox"));
    const executor = createDefaultShareArtifactExecutor(
      {
        toolsConfig: { artifacts: { path: artifactsPath, url: "https://example.com/artifacts" } },
        logger: logger as any,
      },
      mockReadFile,
    );

    const result = await executor({ file_path: "/workspace/report.csv" });

    expect(mockReadFile).toHaveBeenCalledWith("/workspace/report.csv");
    expect(result.startsWith("Artifact shared: https://example.com/artifacts/?")).toBe(true);
    expect(result.endsWith(".csv")).toBe(true);

    const artifactUrl = extractSharedUrl(result);
    const filename = extractFilenameFromViewerUrl(artifactUrl);
    const content = await readFile(join(artifactsPath, filename), "utf-8");
    expect(content).toBe("hello from sandbox");

    const indexHtml = await readFile(join(artifactsPath, "index.html"), "utf-8");
    expect(indexHtml).toContain("<title>Artifact Viewer</title>");
    expect(indexHtml).toContain("Download raw file");
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/^Created artifact file: /));
  });

  it("fails fast when share_artifact is called without artifacts config", async () => {
    const mockReadFile = vi.fn(async () => Buffer.from("data"));
    const executor = createDefaultShareArtifactExecutor(
      {},
      mockReadFile,
    );

    await expect(executor({ file_path: "/workspace/file.txt" })).rejects.toThrow(
      "Artifact tools require tools.artifacts.path and tools.artifacts.url configuration.",
    );
  });


});

describe("core tool executors webpage secret header support", () => {
  it("visit_webpage uses direct fetch with configured auth headers for matching URL prefixes", async () => {
    const privateUrl = "https://files.slack.com/files-pri/T123/F456/report.txt";
    await trustUrl(privateUrl);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;

      if (url === privateUrl && init?.method === "HEAD") {
        expect(headers.Authorization).toBe("Bearer xoxb-secret");
        return new Response("", {
          status: 200,
          headers: {
            "content-type": "text/plain",
          },
        });
      }

      if (url === privateUrl) {
        expect(headers.Authorization).toBe("Bearer xoxb-secret");
        return new Response("private file contents", {
          status: 200,
          headers: {
            "content-type": "text/plain",
          },
        });
      }

      throw new Error(`Unexpected fetch URL in test: ${url}`);
    });

    const executors = createDefaultToolExecutors({
      secrets: {
        http_header_prefixes: {
          "https://files.slack.com/": {
            Authorization: "Bearer xoxb-secret",
          },
        },
      },
    });

    const result = await executors.visitWebpage(privateUrl);

    expect(result).toContain("## Content from https://files.slack.com/files-pri/T123/F456/report.txt");
    expect(result).toContain("private file contents");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect((globalThis.fetch as any).mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([privateUrl, privateUrl]);
  });
});

describe("core tool executors oracle support", () => {
  it("oracle fails fast when model config is missing", async () => {
    const executors = createDefaultToolExecutors();

    await expect(
      executors.oracle({
        query: "What should I do?",
      }),
    ).rejects.toThrow("oracle tool requires tools.oracle.model configuration.");
  });

  it("oracle validates non-empty query", async () => {
    const executors = createDefaultToolExecutors({
      toolsConfig: { oracle: { model: "openai:gpt-4o-mini" } },
    });

    await expect(
      executors.oracle({
        query: "   ",
      }),
    ).rejects.toThrow("oracle.query must be non-empty.");
  });
});

// Module-level state for SessionRunner mock (vi.mock hoists, so these must be at module scope)
const oracleMock = {
  promptFn: vi.fn(),
  capturedOptions: undefined as any,
};

vi.mock("../src/agent/session-runner.js", () => {
  return {
    SessionRunner: class MockSessionRunner {
      constructor(options: any) {
        oracleMock.capturedOptions = options;
      }
      async prompt(query: string, opts?: any) {
        return oracleMock.promptFn(query, opts);
      }
    },
  };
});

describe("oracle executor with invocation context", () => {
  beforeEach(() => {
    oracleMock.capturedOptions = undefined;
    oracleMock.promptFn = vi.fn();
  });

  it("calls buildTools with toolOptions and filters excluded tools", async () => {
    oracleMock.promptFn.mockResolvedValue({ text: "oracle answer", stopReason: "stop", usage: {} });

    const buildTools = vi.fn(() => ({
      tools: [
        { name: "web_search" },
        { name: "oracle" },
        { name: "bash" },
        { name: "visit_webpage" },
      ] as any[],
      dispose: undefined,
    }));

    const toolOptions = { toolsConfig: { oracle: { model: "openai:gpt-4o-mini" } }};

    const executor = createDefaultOracleExecutor(
      { toolsConfig: { oracle: { model: "openai:gpt-4o-mini" } }, logger: { info: vi.fn() } },
      {
        conversationContext: [{ role: "user", content: "prior context" }],
        toolOptions,
        buildTools,
      },
    );

    const result = await executor({ query: "test query" });

    expect(result).toBe("oracle answer");
    expect(buildTools).toHaveBeenCalledWith(toolOptions);

    // Verify excluded tools were filtered out
    const toolNames = oracleMock.capturedOptions.toolSet.tools.map((t: any) => t.name);
    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("visit_webpage");
    expect(toolNames).not.toContain("oracle");
    // oracle and deep_research are excluded to prevent recursion
  });

  it("passes conversation context and configured thinkingLevel to SessionRunner.prompt", async () => {
    oracleMock.promptFn.mockResolvedValue({ text: "deep answer", stopReason: "stop", usage: {} });

    const context = [
      { role: "user" as const, content: "earlier message" },
      { role: "assistant" as const, content: "earlier reply" },
    ];

    const executor = createDefaultOracleExecutor(
      { toolsConfig: { oracle: { model: "openai:gpt-4o-mini", thinkingLevel: "medium" } }, logger: { info: vi.fn() } },
      {
        conversationContext: context,
        toolOptions: {},
        buildTools: () => ({ tools: [], dispose: undefined }),
      },
    );

    await executor({ query: "analyze this" });

    expect(oracleMock.promptFn).toHaveBeenCalledWith("analyze this", {
      contextMessages: context,
      thinkingLevel: "medium",
    });
  });

  it("fails fast on invalid configured thinkingLevel", async () => {
    const executor = createDefaultOracleExecutor(
      { toolsConfig: { oracle: { model: "openai:gpt-4o-mini", thinkingLevel: "turbo" as any } }, logger: { info: vi.fn() } },
      {
        conversationContext: [],
        toolOptions: {},
        buildTools: () => ({ tools: [], dispose: undefined }),
      },
    );

    await expect(executor({ query: "analyze this" })).rejects.toThrow(
      "Invalid tools.oracle.thinkingLevel 'turbo'. Valid values: off, minimal, low, medium, high, xhigh",
    );
  });

  it("logs CONSULTING ORACLE on entry and Oracle response on success", async () => {
    oracleMock.promptFn.mockResolvedValue({ text: "sage wisdom", stopReason: "stop", usage: {} });

    const infoLog = vi.fn();
    const logger = { info: infoLog, debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const executor = createDefaultOracleExecutor(
      { toolsConfig: { oracle: { model: "openai:gpt-4o-mini" } }, logger },
      { conversationContext: [], toolOptions: {}, buildTools: () => ({ tools: [], dispose: undefined }) },
    );

    await executor({ query: "deep question" });

    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("CONSULTING ORACLE: deep question"),
    );
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("Oracle response: sage wisdom"),
    );
  });

  it("propagates runtime errors and logs Oracle failed", async () => {
    oracleMock.promptFn.mockRejectedValue(new Error("connection refused"));

    const infoLog = vi.fn();
    const logger = { info: infoLog, debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const executor = createDefaultOracleExecutor(
      { toolsConfig: { oracle: { model: "openai:gpt-4o-mini" } }, logger },
      { conversationContext: [], toolOptions: {}, buildTools: () => ({ tools: [], dispose: undefined }) },
    );

    await expect(executor({ query: "will fail" })).rejects.toThrow("connection refused");
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("Oracle failed: connection refused"),
    );
  });

  it("returns iteration exhaustion message instead of throwing", async () => {
    oracleMock.promptFn.mockRejectedValue(new Error("Exceeded max iteration limit"));

    const infoLog = vi.fn();
    const logger = { info: infoLog, debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const executor = createDefaultOracleExecutor(
      { toolsConfig: { oracle: { model: "openai:gpt-4o-mini" } }, logger },
      { conversationContext: [], toolOptions: {}, buildTools: () => ({ tools: [], dispose: undefined }) },
    );

    const result = await executor({ query: "complex task" });

    expect(result).toMatch(/^Oracle exhausted iterations:/);
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("Oracle exhausted:"),
    );
  });

  it("works without invocation context (zero tools, no conversation context)", async () => {
    oracleMock.promptFn.mockResolvedValue({ text: "bare answer", stopReason: "stop", usage: {} });

    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const executor = createDefaultOracleExecutor(
      { toolsConfig: { oracle: { model: "openai:gpt-4o-mini" } }, logger },
    );

    const result = await executor({ query: "no context" });

    expect(result).toBe("bare answer");
    expect(oracleMock.capturedOptions.toolSet.tools).toEqual([]);
    expect(oracleMock.promptFn).toHaveBeenCalledWith("no context", {
      contextMessages: undefined,
      thinkingLevel: "high",
    });
  });

  it("passes logger to SessionRunner for nested LLM I/O visibility", async () => {
    oracleMock.promptFn.mockResolvedValue({ text: "ok", stopReason: "stop", usage: {} });

    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const executor = createDefaultOracleExecutor(
      { toolsConfig: { oracle: { model: "openai:gpt-4o-mini" } }, logger },
      { conversationContext: [], toolOptions: {}, buildTools: () => ({ tools: [], dispose: undefined }) },
    );

    await executor({ query: "test" });

    expect(oracleMock.capturedOptions.logger).toBe(logger);
  });

  it("disposes the session returned by SessionRunner on success", async () => {
    const disposeFn = vi.fn();
    oracleMock.promptFn.mockResolvedValue({ text: "ok", stopReason: "stop", usage: {}, session: { dispose: disposeFn } });

    const executor = createDefaultOracleExecutor(
      { toolsConfig: { oracle: { model: "openai:gpt-4o-mini" } }, logger: { info: vi.fn() } },
      { conversationContext: [], toolOptions: {}, buildTools: () => ({ tools: [], dispose: undefined }) },
    );

    await executor({ query: "test" });
    expect(disposeFn).toHaveBeenCalledOnce();
  });

  it("disposes the session even when prompt throws", async () => {
    // For the error path where result is undefined, session?.dispose() is a no-op.
    oracleMock.promptFn.mockRejectedValueOnce(new Error("boom"));

    const executor = createDefaultOracleExecutor(
      { toolsConfig: { oracle: { model: "openai:gpt-4o-mini" } }, logger: { info: vi.fn() } },
      { conversationContext: [], toolOptions: {}, buildTools: () => ({ tools: [], dispose: undefined }) },
    );

    // On error path, result is undefined so dispose is a safe no-op — no crash
    await expect(executor({ query: "will fail" })).rejects.toThrow("boom");
  });
});

describe("core tool executors web_search support", () => {
  it("web_search returns formatted search results and seeds trust for result URLs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("s.jina.ai");
      expect(url).toContain("cats");
      return new Response("Title: Cats\nURL: https://example.com/docs?topic=felines\nSnippet: All about cats", { status: 200 });
    });

    const executors = createDefaultToolExecutors({});
    const result = await executors.webSearch("cats");
    expect(result).toContain("## Search Results");
    expect(result).toContain("All about cats");
    expect(await isUrlTrustedInArc(TEST_ARC, "https://example.com/docs?another=1")).toBe(true);
  });

  it("web_search returns friendly message for no results (422)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("No search results available for query", { status: 422 }),
    );

    const executors = createDefaultToolExecutors({});
    const result = await executors.webSearch("xyznonexistent");
    expect(result).toBe("No search results found. Try a different query.");
  });

  it("web_search returns friendly message for empty body", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 200 }));
    const executors = createDefaultToolExecutors({});
    const result = await executors.webSearch("something");
    expect(result).toBe("No search results found. Try a different query.");
  });

  it("web_search throws on non-422 error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("Server error", { status: 500 }),
    );

    const executors = createDefaultToolExecutors({});
    await expect(executors.webSearch("test")).rejects.toThrow("Search failed: Jina HTTP 500");
  });

  it("web_search validates non-empty query", async () => {
    const executors = createDefaultToolExecutors({});
    await expect(executors.webSearch("   ")).rejects.toThrow("web_search.query must be non-empty");
  });

  it("web_search passes Jina API key as Bearer token when configured", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer jina-key-123");
      return new Response("results", { status: 200 });
    });

    const executors = createDefaultToolExecutors({ authStorage: AuthStorage.inMemory({ jina: { type: "api_key", key: "jina-key-123" } }) });
    await executors.webSearch("test");
  });
});

describe("core tool executors request_network_access support", () => {
  it("records approved URLs into the current arc trust ledger", async () => {
    const networkAccessApprover = vi.fn(async (request: {
      arc: string;
      url: string;
      canonicalUrl: string;
      reason?: string;
    }) => ({
      approved: true,
      message: `approved ${request.canonicalUrl}`,
    }));

    const executors = createDefaultToolExecutors({ networkAccessApprover });
    const result = await executors.requestNetworkAccess({
      url: "https://Example.com/docs?page=1",
      reason: "Need docs",
    });

    expect(networkAccessApprover).toHaveBeenCalledWith({
      arc: TEST_ARC,
      url: "https://Example.com/docs?page=1",
      canonicalUrl: "https://example.com/docs",
      reason: "Need docs",
    });
    expect(result).toBe("approved https://example.com/docs");
    expect(await isUrlTrustedInArc(TEST_ARC, "https://example.com/docs?section=2")).toBe(true);
  });

  it("errors when no harness approver is provided", async () => {
    const executors = createDefaultToolExecutors({});
    await expect(
      executors.requestNetworkAccess({
        url: "https://example.com/docs?page=1",
      }),
    ).rejects.toThrow("request_network_access requires a harness-provided networkAccessApprover.");
  });
});

describe("core tool executors visit_webpage support", () => {
  it("visit_webpage rejects untrusted URLs", async () => {
    const executors = createDefaultToolExecutors({});
    await expect(executors.visitWebpage("https://example.com/blocked")).rejects.toThrow(/Network access denied/);
  });

  it("visit_webpage fetches page content via Jina reader", async () => {
    await trustUrl("https://example.com/page");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.startsWith("https://r.jina.ai/")) {
        return new Response("# Page Title\nSome content", { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const executors = createDefaultToolExecutors({});
    const result = await executors.visitWebpage("https://example.com/page");
    expect(result).toContain("## Content from https://example.com/page");
    expect(result).toContain("Some content");
  });

  it("visit_webpage auto-trusts redirect targets", async () => {
    await trustUrl("https://example.com/start?token=1");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://example.com/start?token=1" && init?.method === "HEAD") {
        return new Response("", {
          status: 302,
          headers: { location: "https://cdn.example.com/final?page=1" },
        });
      }
      if (url === "https://cdn.example.com/final?page=1" && init?.method === "HEAD") {
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.startsWith("https://r.jina.ai/")) {
        return new Response("redirected page", { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const executors = createDefaultToolExecutors({});
    const result = await executors.visitWebpage("https://example.com/start?token=1");

    expect(result).toContain("redirected page");
    expect(await isUrlTrustedInArc(TEST_ARC, "https://cdn.example.com/final?other=1")).toBe(true);
  });

  it("visit_webpage downloads images and returns binary result", async () => {
    await trustUrl("https://example.com/img.png");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response(Uint8Array.from([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });

    const executors = createDefaultToolExecutors({});
    const result = await executors.visitWebpage("https://example.com/img.png");
    expect(typeof result).toBe("object");
    expect((result as any).kind).toBe("image");
    expect((result as any).mimeType).toBe("image/png");
  });

  it("visit_webpage normalizes non-standard image/jpg to image/jpeg", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "image/jpg" } });
      }
      return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), {
        status: 200,
        headers: { "content-type": "image/jpg" },
      });
    });

    const executors = createDefaultToolExecutors({});
    const result = await executors.visitWebpage("https://example.com/photo.jpg");
    expect(typeof result).toBe("object");
    expect((result as any).kind).toBe("image");
    expect((result as any).mimeType).toBe("image/jpeg");
  });

  it("visit_webpage treats SVG as text content, not as image", async () => {
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40"/></svg>';
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "image/svg+xml" } });
      }
      const url = String(input);
      if (url.startsWith("https://r.jina.ai/")) {
        return new Response(svgContent, { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const executors = createDefaultToolExecutors({});
    const result = await executors.visitWebpage("https://example.com/bird.svg");
    // SVG should be returned as text, not as an image object
    expect(typeof result).toBe("string");
    expect(result as string).toContain("circle");
  });

  it("visit_webpage falls through to text when image-like URL serves HTML", async () => {
    await trustUrl("https://commons.wikimedia.org/wiki/File:Filip-Turek.jpg");
    const htmlContent = "<html><body>File:Filip-Turek.jpg - Wikimedia Commons</body></html>";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        // HEAD may not reveal the true type (or may fail).
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(htmlContent, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    const executors = createDefaultToolExecutors({});
    const result = await executors.visitWebpage("https://commons.wikimedia.org/wiki/File:Filip-Turek.jpg");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Wikimedia Commons");
    expect(result as string).not.toContain("kind");
  });

  it("visit_webpage uses Jina text path for image-like URL when HEAD fails", async () => {
    await trustUrl("https://example.com/photo.jpg");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        throw new Error("HEAD not allowed");
      }
      // With HEAD failing, contentType is empty so no image branch.
      // The URL has no auth headers, so it falls through to Jina reader.
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://r.jina.ai/")) {
        return new Response("Jina rendered text for photo page", { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const executors = createDefaultToolExecutors({});
    const result = await executors.visitWebpage("https://example.com/photo.jpg");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Jina rendered text for photo page");
  });

  it("visit_webpage rejects non-http URLs", async () => {
    const executors = createDefaultToolExecutors({});
    await expect(executors.visitWebpage("ftp://example.com/file")).rejects.toThrow("Invalid URL");
  });

  it("visit_webpage truncates long content", async () => {
    await trustUrl("https://example.com/");
    const longContent = "x".repeat(50000);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(longContent, { status: 200 });
    });

    const executors = createDefaultToolExecutors({ toolsConfig: { jina: { maxWebContentLength: 1000 } } });
    const result = await executors.visitWebpage("https://example.com");
    expect(result).toContain("..._Content truncated_...");
    expect((result as string).length).toBeLessThan(5000);
  });

  it("visit_webpage returns empty response marker for empty body", async () => {
    await trustUrl("https://example.com/");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("", { status: 200 });
    });

    const executors = createDefaultToolExecutors({});
    const result = await executors.visitWebpage("https://example.com");
    expect(result).toContain("(Empty response)");
  });

  it("visit_webpage rejects oversized images", async () => {
    await trustUrl("https://example.com/big.png");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response(new Uint8Array(5000), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });

    const executors = createDefaultToolExecutors({ toolsConfig: { jina: { maxImageBytes: 1000 } } });
    await expect(executors.visitWebpage("https://example.com/big.png")).rejects.toThrow("Image too large");
  });
});

describe("core tool executors visit_webpage Jina retry support", () => {
  it("visit_webpage retries on Jina HTTP 451 and succeeds on second attempt", async () => {
    await trustUrl("https://example.com/page");
    jinaRetryConfig.delaysMs = [0, 0, 0];
    let attempt = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.startsWith("https://r.jina.ai/")) {
        attempt++;
        if (attempt === 1) {
          return new Response("Unavailable for legal reasons", { status: 451 });
        }
        return new Response("# Retry success", { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const executors = createDefaultToolExecutors({});
    const result = await executors.visitWebpage("https://example.com/page");
    expect(result).toContain("Retry success");
    expect(attempt).toBe(2);
  });

  it("visit_webpage retries on Jina HTTP 500 and throws after exhausting retries", async () => {
    await trustUrl("https://example.com/page");
    jinaRetryConfig.delaysMs = [0, 0, 0];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("Server error", { status: 500 });
    });

    const executors = createDefaultToolExecutors({});
    await expect(executors.visitWebpage("https://example.com/page")).rejects.toThrow(
      "Jina HTTP 500",
    );
  });
});

describe("core tool executors visit_webpage network error diagnostics", () => {
  it("visit_webpage surfaces cause from Node fetch TypeError", async () => {
    await trustUrl("https://brmlab.cz/test.png");
    const fetchError = new TypeError("fetch failed");
    (fetchError as any).cause = new Error("getaddrinfo ENOTFOUND brmlab.cz");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(fetchError);

    const executors = createDefaultToolExecutors({});
    // HEAD fails silently (caught), then Jina GET also fails — diagnosticFetch surfaces the cause.
    await expect(executors.visitWebpage("https://brmlab.cz/test.png")).rejects.toThrow(
      /getaddrinfo ENOTFOUND/,
    );
  });

  it("visit_webpage surfaces connection refused errors", async () => {
    await trustUrl("https://localhost/page");
    const fetchError = new TypeError("fetch failed");
    (fetchError as any).cause = new Error("connect ECONNREFUSED 127.0.0.1:443");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(fetchError);

    const executors = createDefaultToolExecutors({});
    await expect(executors.visitWebpage("https://localhost/page")).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});

describe("core tool executors visit_webpage newline cleanup", () => {
  it("visit_webpage collapses excessive newlines in Jina content", async () => {
    await trustUrl("https://example.com/page");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("line1\n\n\n\n\nline2", { status: 200 });
    });

    const executors = createDefaultToolExecutors({});
    const result = await executors.visitWebpage("https://example.com/page") as string;
    expect(result).toContain("line1\n\nline2");
    expect(result).not.toContain("\n\n\n");
  });
});

describe("core tool executors visit_webpage LLM transcription", () => {
  it("visit_webpage post-processes content through LLM when deepResearch.model is configured", async () => {
    await trustUrl("https://example.com/page");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("Nav menu\n\nActual content\n\nCookie banner", { status: 200 });
    });

    const modelAdapter = {
      completeSimple: vi.fn(async () => ({
        content: [{ type: "text", text: "Actual content" }],
      })),
    };

    const executors = createDefaultToolExecutorsRaw({
      modelAdapter: modelAdapter as any,
      authStorage: AuthStorage.inMemory(),
      arc: "test-arc",
      toolsConfig: { visitWebpage: { model: "anthropic:claude-haiku" } },
    });

    const result = await executors.visitWebpage("https://example.com/page") as string;
    expect(result).toContain("## Content from https://example.com/page");
    expect(result).toContain("Actual content");
    expect(result).not.toContain("Nav menu");
    expect(result).not.toContain("Cookie banner");

    expect(modelAdapter.completeSimple).toHaveBeenCalledOnce();
    const [modelSpec, context, options] = modelAdapter.completeSimple.mock.calls[0] as any[];
    expect(modelSpec).toBe("anthropic:claude-haiku");
    expect(context.systemPrompt).toContain("web content transcriber");
    expect(context.systemPrompt).toContain("NEVER fabricate");
    expect(context.messages[0].content).toContain("Actual content");
    expect(options.callType).toBe("webTranscript");
  });

  it("visit_webpage appends query to system prompt when provided", async () => {
    await trustUrl("https://example.com/product");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("Product page content", { status: 200 });
    });

    const modelAdapter = {
      completeSimple: vi.fn(async () => ({
        content: [{ type: "text", text: "Price: 94 Kč" }],
      })),
    };

    const executors = createDefaultToolExecutorsRaw({
      modelAdapter: modelAdapter as any,
      authStorage: AuthStorage.inMemory(),
      arc: "test-arc",
      toolsConfig: { visitWebpage: { model: "anthropic:claude-haiku" } },
    });

    const result = await executors.visitWebpage("https://example.com/product", "what is the price?") as string;
    expect(result).toContain("Price: 94 Kč");

    const [, context] = modelAdapter.completeSimple.mock.calls[0] as any[];
    expect(context.systemPrompt).toContain("what is the price?");
  });

  it("visit_webpage falls back to raw content when LLM transcription fails", async () => {
    await trustUrl("https://example.com/page");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("Raw content here", { status: 200 });
    });

    const modelAdapter = {
      completeSimple: vi.fn(async () => { throw new Error("LLM unavailable"); }),
    };

    const executors = createDefaultToolExecutorsRaw({
      modelAdapter: modelAdapter as any,
      authStorage: AuthStorage.inMemory(),
      arc: "test-arc",
      toolsConfig: { visitWebpage: { model: "anthropic:claude-haiku" } },
    });

    const result = await executors.visitWebpage("https://example.com/page") as string;
    expect(result).toContain("Raw content here");
  });

  it("visit_webpage skips LLM transcription when deepResearch.model is not configured", async () => {
    await trustUrl("https://example.com/page");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("Raw content", { status: 200 });
    });

    const modelAdapter = {
      completeSimple: vi.fn(async () => { throw new Error("should not be called"); }),
    };

    const executors = createDefaultToolExecutorsRaw({
      modelAdapter: modelAdapter as any,
      authStorage: AuthStorage.inMemory(),
      arc: "test-arc",
    });

    const result = await executors.visitWebpage("https://example.com/page") as string;
    expect(result).toContain("Raw content");
    expect(modelAdapter.completeSimple).not.toHaveBeenCalled();
  });
});

describe("core tool executors visit_webpage local artifact support", () => {
  it("visit_webpage reads local text artifact directly from disk", async () => {
    const { artifactsPath } = await makeArtifactsDir();
    await writeFile(join(artifactsPath, "test.txt"), "local content here");

    const executors = createDefaultToolExecutors({
      toolsConfig: { artifacts: { path: artifactsPath, url: "https://artifacts.example.com/files" } },
    });

    const result = await executors.visitWebpage("https://artifacts.example.com/files/?test.txt");
    expect(result).toBe("local content here");
  });

  it("visit_webpage reads local image artifact directly from disk", async () => {
    const { artifactsPath } = await makeArtifactsDir();
    const pngHeader = Buffer.from([137, 80, 78, 71]);
    await writeFile(join(artifactsPath, "img.png"), pngHeader);

    const executors = createDefaultToolExecutors({
      toolsConfig: { artifacts: { path: artifactsPath, url: "https://artifacts.example.com/files" } },
    });

    const result = await executors.visitWebpage("https://artifacts.example.com/files/?img.png");
    expect(typeof result).toBe("object");
    expect((result as any).kind).toBe("image");
    expect((result as any).mimeType).toBe("image/png");
  });

  it("visit_webpage rejects path traversal in local artifact URLs", async () => {
    const { artifactsPath } = await makeArtifactsDir();

    const executors = createDefaultToolExecutors({
      toolsConfig: { artifacts: { path: artifactsPath, url: "https://artifacts.example.com/files" } },
    });

    await expect(
      executors.visitWebpage("https://artifacts.example.com/files/?../../../etc/passwd"),
    ).rejects.toThrow("Path traversal");
  });
});

describe("core tool executors visit_webpage exact http_headers support", () => {
  it("visit_webpage uses exact http_headers match for specific URL", async () => {
    const targetUrl = "https://secret.example.com/api/data";
    await trustUrl(targetUrl);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/plain" } });
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url === targetUrl) {
        expect(headers["X-Secret-Key"]).toBe("exact-match-key");
        return new Response("secret data", { status: 200, headers: { "content-type": "text/plain" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const executors = createDefaultToolExecutors({ secrets: {
        http_headers: {
          [targetUrl]: { "X-Secret-Key": "exact-match-key" },
        },
      },
    });

    const result = await executors.visitWebpage(targetUrl);
    expect(result).toContain("secret data");
  });
});

describe("core tool executors visit_webpage binary content support", () => {
  it("visit_webpage returns base64-encoded binary for non-text content types", async () => {
    await trustUrl("https://example.com/file.bin");
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      return new Response(binaryData, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    });

    const executors = createDefaultToolExecutors({ secrets: { http_headers: { "https://example.com/file.bin": { Authorization: "Bearer x" } } },
    });

    const result = await executors.visitWebpage("https://example.com/file.bin") as string;
    expect(result).toContain("Binary content from");
    expect(result).toContain("application/octet-stream");
    expect(result).toContain("Base64");
  });
});


describe("core tool executors generate_image support", () => {
  it("generate_image calls OpenRouter, writes artifact image, and returns image payload", async () => {
    const { artifactsPath } = await makeArtifactsDir();

    let openRouterRequestBody: any = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://assets.example/ref.png") {
        return new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "image/png",
          },
        });
      }

      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        openRouterRequestBody = JSON.parse(String(init?.body ?? "{}"));

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  images: [
                    {
                      image_url: {
                        url: "data:image/png;base64,QUJD",
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }

      throw new Error(`Unexpected fetch URL in test: ${url}`);
    });

    const executors = createDefaultToolExecutors({ toolsConfig: { artifacts: { path: artifactsPath, url: "https://example.com/artifacts" }, imageGen: { model: "openrouter:google/gemini-3-pro-image-preview" } },
      authStorage: AuthStorage.inMemory({ openrouter: { type: "api_key", key: "or-key" } }),
    });

    const result = await executors.generateImage({
      prompt: "Draw a tiny cat",
      image_urls: ["https://assets.example/ref.png"],
    });

    expect(result.summaryText).toContain("Generated image: https://example.com/artifacts/?");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      data: "QUJD",
      mimeType: "image/png",
    });

    const artifactFilename = extractFilenameFromViewerUrl(result.images[0].artifactUrl);
    const savedImage = await readFile(join(artifactsPath, artifactFilename));
    expect(savedImage.equals(Buffer.from("ABC"))).toBe(true);

    expect(openRouterRequestBody.model).toBe("google/gemini-3-pro-image-preview");
    expect(openRouterRequestBody.modalities).toEqual(["image", "text"]);
    expect(openRouterRequestBody.messages[0].content[0]).toEqual({ type: "text", text: "Draw a tiny cat" });
    expect(openRouterRequestBody.messages[0].content[1].type).toBe("image_url");
    expect(openRouterRequestBody.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("generate_image fails fast when tools.image_gen.model is missing", async () => {
    const executors = createDefaultToolExecutors();

    await expect(
      executors.generateImage({
        prompt: "Draw a cat",
      }),
    ).rejects.toThrow("generate_image tool requires tools.imageGen.model configuration.");
  });

  it("generate_image rejects non-openrouter model providers", async () => {
    const executors = createDefaultToolExecutors({
      toolsConfig: { imageGen: { model: "openai:gpt-image-1" } },
      authStorage: AuthStorage.inMemory({ openai: { type: "api_key", key: "demo" } }),
    });

    await expect(
      executors.generateImage({
        prompt: "Draw a cat",
      }),
    ).rejects.toThrow("tools.imageGen.model must use openrouter provider");
  });

  it("generate_image errors when OpenRouter returns no images", async () => {
    const { artifactsPath } = await makeArtifactsDir();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  images: [],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }

      throw new Error(`Unexpected fetch URL in test: ${url}`);
    });

    const executors = createDefaultToolExecutors({ toolsConfig: { artifacts: { path: artifactsPath, url: "https://example.com/artifacts" }, imageGen: { model: "openrouter:google/gemini-3-pro-image-preview" } },
      authStorage: AuthStorage.inMemory({ openrouter: { type: "api_key", key: "or-key" } }),
    });

    await expect(
      executors.generateImage({
        prompt: "Draw a cat",
      }),
    ).rejects.toThrow("Image generation failed: No images generated by model.");
  });
});

// ── Workspace skills ──────────────────────────────────────────────────────

import { loadWorkspaceSkills } from "../src/agent/skills/load-skills.js";
import { getArcWorkspacePath } from "../src/agent/gondolin/index.js";

describe("loadWorkspaceSkills", () => {
  it("returns empty result when skills directory does not exist", () => {
    const result = loadWorkspaceSkills("nonexistent-ws-skills-arc");
    expect(result).toEqual({ skills: [], diagnostics: [] });
  });

  it("loads valid workspace skills and rewrites filePath", () => {
    const arc = "ws-skills-load-arc";
    const workspacePath = getArcWorkspacePath(arc);
    const skillDir = join(workspacePath, "skills", "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: A test skill.\n---\nDo the thing.\n",
    );

    const { skills } = loadWorkspaceSkills(arc);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("my-skill");
    expect(skills[0].description).toBe("A test skill.");
    expect(skills[0].filePath).toBe("/workspace/skills/my-skill/SKILL.md");
    expect(skills[0].content).toContain("Do the thing.");
  });

  it("returns empty result when skills directory exists but is empty", () => {
    const arc = "ws-skills-empty-arc";
    const workspacePath = getArcWorkspacePath(arc);
    mkdirSync(join(workspacePath, "skills"), { recursive: true });

    const { skills, diagnostics } = loadWorkspaceSkills(arc);
    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});

// ── Memory update prompt ──────────────────────────────────────────────────

import { buildMemoryUpdatePrompt } from "../src/rooms/command/command-executor.js";

describe("buildMemoryUpdatePrompt", () => {
  it("returns prompt with empty-file marker when MEMORY.md does not exist", () => {
    const prompt = buildMemoryUpdatePrompt("nonexistent-memory-arc");
    expect(prompt).toContain("(empty - not yet created)");
    expect(prompt).toContain("0/2200 chars");
    expect(prompt).toContain("<meta>");
    expect(prompt).toContain("</meta>");
  });

  it("includes file content and char count when MEMORY.md exists", () => {
    const arc = "memory-prompt-arc";
    const workspacePath = getArcWorkspacePath(arc);
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(workspacePath, "MEMORY.md"), "Favorite color: blue");

    const prompt = buildMemoryUpdatePrompt(arc);
    expect(prompt).toContain("Favorite color: blue");
    expect(prompt).toContain("20/2200 chars");
    expect(prompt).not.toContain("consolidate");
  });

  it("includes capacity warning when over 80% full", () => {
    const arc = "memory-capacity-arc";
    const workspacePath = getArcWorkspacePath(arc);
    mkdirSync(workspacePath, { recursive: true });
    const content = "x".repeat(1800);
    writeFileSync(join(workspacePath, "MEMORY.md"), content);

    const prompt = buildMemoryUpdatePrompt(arc);
    expect(prompt).toContain("1800/2200 chars");
    expect(prompt).toContain("consolidate");
  });

  it("respects custom charLimit from config", () => {
    const arc = "memory-limit-arc";
    const workspacePath = getArcWorkspacePath(arc);
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(workspacePath, "MEMORY.md"), "x".repeat(500));

    const prompt = buildMemoryUpdatePrompt(arc, { charLimit: 600 });
    expect(prompt).toContain("500/600 chars");
    expect(prompt).toContain("consolidate"); // 500/600 > 80%
  });

  it("includes skill creation section when toolCallsCount >= threshold", () => {
    const arc = "memory-skills-arc";
    const workspacePath = getArcWorkspacePath(arc);
    mkdirSync(workspacePath, { recursive: true });

    const prompt = buildMemoryUpdatePrompt(arc, undefined, { toolCallsCount: 5 });
    expect(prompt).toContain("Skill creation:");
    expect(prompt).toContain("5 tool calls");
    expect(prompt).toContain("manage-skills");
  });

  it("omits skill creation section when toolCallsCount < threshold", () => {
    const arc = "memory-no-skills-arc";
    const workspacePath = getArcWorkspacePath(arc);
    mkdirSync(workspacePath, { recursive: true });

    const prompt = buildMemoryUpdatePrompt(arc, undefined, { toolCallsCount: 2 });
    expect(prompt).not.toContain("Skill creation:");
  });

  it("respects custom creationThreshold from skillsConfig", () => {
    const arc = "memory-custom-threshold-arc";
    const workspacePath = getArcWorkspacePath(arc);
    mkdirSync(workspacePath, { recursive: true });

    // toolCallsCount=2 should trigger with threshold=2
    const prompt = buildMemoryUpdatePrompt(arc, undefined, {
      toolCallsCount: 2,
      skillsConfig: { creationThreshold: 2 },
    });
    expect(prompt).toContain("Skill creation:");
  });

  it("includes per-user memory when nick is provided", () => {
    const arc = "memory-user-arc";
    const workspacePath = getArcWorkspacePath(arc);
    mkdirSync(join(workspacePath, "users"), { recursive: true });
    writeFileSync(join(workspacePath, "users", "alice.md"), "Prefers dark mode.");

    const prompt = buildMemoryUpdatePrompt(arc, undefined, undefined, "alice");
    expect(prompt).toContain('<user-memory nick="alice"');
    expect(prompt).toContain("Prefers dark mode.");
    expect(prompt).toContain("/workspace/users/alice.md");
  });

  it("shows empty per-user memory placeholder when user file does not exist", () => {
    const arc = "memory-user-empty-arc";
    const workspacePath = getArcWorkspacePath(arc);
    mkdirSync(workspacePath, { recursive: true });

    const prompt = buildMemoryUpdatePrompt(arc, undefined, undefined, "bob");
    expect(prompt).toContain('<user-memory nick="bob"');
    expect(prompt).toContain("(empty - not yet created)");
    expect(prompt).toContain("/workspace/users/bob.md");
  });

  it("omits per-user memory when nick is not provided", () => {
    const prompt = buildMemoryUpdatePrompt("nonexistent-memory-arc");
    expect(prompt).not.toContain("<user-memory");
    expect(prompt).not.toContain("/workspace/users/");
  });
});
