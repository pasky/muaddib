import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { createDefaultToolExecutors as createDefaultToolExecutorsRaw } from "../src/agent/tools/baseline-tools.js";
import { createDefaultShareArtifactExecutor } from "../src/agent/tools/artifact.js";
import { createDefaultOracleExecutor as createDefaultOracleExecutorRaw } from "../src/agent/tools/oracle.js";
import { PiAiModelAdapter } from "../src/models/pi-ai-model-adapter.js";
import { resetWebRateLimiters, jinaRetryConfig } from "../src/agent/tools/web.js";
const tempDirs: string[] = [];
const originalJinaRetryDelays = [...jinaRetryConfig.delaysMs];

beforeEach(() => {
  resetWebRateLimiters();
});

afterEach(async () => {
  vi.restoreAllMocks();
  jinaRetryConfig.delaysMs = [...originalJinaRetryDelays];
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
    ...(options as any),
  });
}

function createDefaultOracleExecutor(options: Record<string, unknown> = {}, invocation?: any) {
  return createDefaultOracleExecutorRaw({
    modelAdapter: new PiAiModelAdapter(),
    authStorage: AuthStorage.inMemory(),
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
        { name: "progress_report" },
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
    expect(toolNames).not.toContain("progress_report");
  });

  it("passes conversation context and thinkingLevel high to SessionRunner.prompt", async () => {
    oracleMock.promptFn.mockResolvedValue({ text: "deep answer", stopReason: "stop", usage: {} });

    const context = [
      { role: "user" as const, content: "earlier message" },
      { role: "assistant" as const, content: "earlier reply" },
    ];

    const executor = createDefaultOracleExecutor(
      { toolsConfig: { oracle: { model: "openai:gpt-4o-mini" } }, logger: { info: vi.fn() } },
      {
        conversationContext: context,
        toolOptions: {},
        buildTools: () => ({ tools: [], dispose: undefined }),
      },
    );

    await executor({ query: "analyze this" });

    expect(oracleMock.promptFn).toHaveBeenCalledWith("analyze this", {
      contextMessages: context,
      thinkingLevel: "high",
    });
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
});

describe("core tool executors web_search support", () => {
  it("web_search returns formatted search results", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("s.jina.ai");
      expect(url).toContain("cats");
      return new Response("Title: Cats\nURL: https://example.com\nSnippet: All about cats", { status: 200 });
    });

    const executors = createDefaultToolExecutors({});
    const result = await executors.webSearch("cats");
    expect(result).toContain("## Search Results");
    expect(result).toContain("All about cats");
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

describe("core tool executors visit_webpage support", () => {
  it("visit_webpage fetches page content via Jina reader", async () => {
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

  it("visit_webpage downloads images and returns binary result", async () => {
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

  it("visit_webpage falls through to text when image-like URL serves HTML", async () => {
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

// ── Memory update prompt ──────────────────────────────────────────────────

import { buildMemoryUpdatePrompt } from "../src/rooms/command/command-executor.js";
import { getArcWorkspacePath } from "../src/agent/tools/gondolin-tools.js";

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
});
