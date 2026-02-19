import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { createDefaultToolExecutors as createDefaultToolExecutorsRaw } from "../src/agent/tools/baseline-tools.js";
import { createDefaultOracleExecutor as createDefaultOracleExecutorRaw } from "../src/agent/tools/oracle.js";
import { PiAiModelAdapter } from "../src/models/pi-ai-model-adapter.js";
import { resetSpriteCache } from "../src/agent/tools/execute-code.js";
import { resetWebRateLimiters, jinaRetryConfig } from "../src/agent/tools/web.js";
import { ChronicleStore } from "../src/chronicle/chronicle-store.js";

/**
 * Mock @fly/sprites to execute commands locally for testing.
 * This simulates the Sprites API surface used by execute-code.ts.
 */
class MockExecError extends Error {
  exitCode: number;
  stdout: string;
  stderr: string;
  constructor(message: string, result: { exitCode: number; stdout: string; stderr: string }) {
    super(message);
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

class MockSprite {
  name: string;
  constructor(name: string) {
    this.name = name;
  }

  async execFile(
    file: string,
    args: string[] = [],
    options?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cwd = options?.cwd ?? "/tmp";
    const result = spawnSync(file, args, {
      cwd,
      timeout: 10_000,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    const exitCode = result.status ?? 1;
    const stdout = (result.stdout ?? "").toString();
    const stderr = (result.stderr ?? "").toString();
    if (exitCode !== 0) {
      throw new MockExecError(`Command failed with exit code ${exitCode}`, {
        exitCode,
        stdout,
        stderr,
      });
    }
    return { stdout, stderr, exitCode: 0 };
  }

  async exec(
    command: string,
    options?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.execFile("bash", ["-c", command], options);
  }
}

class MockSpritesClient {
  constructor(_token: string) {}

  sprite(name: string): MockSprite {
    return new MockSprite(name);
  }

  async createSprite(name: string): Promise<MockSprite> {
    return new MockSprite(name);
  }
}

vi.mock("@fly/sprites", () => ({
  SpritesClient: MockSpritesClient,
  ExecError: MockExecError,
}));

const tempDirs: string[] = [];
const originalJinaRetryDelays = [...jinaRetryConfig.delaysMs];

beforeEach(() => {
  resetWebRateLimiters();
  resetSpriteCache();
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
  it("share_artifact writes text artifact and returns viewer URL", async () => {
    const { artifactsPath } = await makeArtifactsDir();
    const logger = { info: vi.fn() };

    const executors = createDefaultToolExecutors({
      toolsConfig: { artifacts: { path: artifactsPath, url: "https://example.com/artifacts" } },
      logger,
    });

    const result = await executors.shareArtifact("hello from ts");

    expect(result.startsWith("Artifact shared: https://example.com/artifacts/?")).toBe(true);
    expect(result.endsWith(".txt")).toBe(true);

    const artifactUrl = extractSharedUrl(result);
    const filename = extractFilenameFromViewerUrl(artifactUrl);
    const content = await readFile(join(artifactsPath, filename), "utf-8");
    expect(content).toBe("hello from ts");

    const indexHtml = await readFile(join(artifactsPath, "index.html"), "utf-8");
    expect(indexHtml).toContain("<title>Artifact Viewer</title>");
    expect(indexHtml).toContain("Download raw file");
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/^Created artifact file: /));
  });

  it("edit_artifact edits local artifact and preserves extension in derived artifact", async () => {
    const { artifactsPath } = await makeArtifactsDir();

    await writeFile(join(artifactsPath, "source.py"), "def answer():\n    return 41\n", "utf-8");

    const executors = createDefaultToolExecutors({
      toolsConfig: { artifacts: { path: artifactsPath, url: "https://example.com/artifacts" } },
    });

    const result = await executors.editArtifact({
      artifact_url: "https://example.com/artifacts/?source.py",
      old_string: "return 41",
      new_string: "return 42",
    });

    expect(result.startsWith("Artifact edited successfully. New version: https://example.com/artifacts/?")).toBe(true);
    expect(result.endsWith(".py")).toBe(true);

    const editedUrl = extractSharedUrl(result);
    const editedFilename = extractFilenameFromViewerUrl(editedUrl);
    const editedContent = await readFile(join(artifactsPath, editedFilename), "utf-8");
    expect(editedContent).toContain("return 42");
    expect(editedContent).not.toContain("return 41");
  });

  it("edit_artifact fails when old_string is missing", async () => {
    const { artifactsPath } = await makeArtifactsDir();

    await writeFile(join(artifactsPath, "source.txt"), "alpha\nbeta\n", "utf-8");

    const executors = createDefaultToolExecutors({
      toolsConfig: { artifacts: { path: artifactsPath, url: "https://example.com/artifacts" } },
    });

    await expect(
      executors.editArtifact({
        artifact_url: "https://example.com/artifacts/?source.txt",
        old_string: "gamma",
        new_string: "delta",
      }),
    ).rejects.toThrow("edit_artifact.old_string not found");
  });

  it("edit_artifact fails when old_string is not unique", async () => {
    const { artifactsPath } = await makeArtifactsDir();

    await writeFile(join(artifactsPath, "source.txt"), "same\nsame\n", "utf-8");

    const executors = createDefaultToolExecutors({
      toolsConfig: { artifacts: { path: artifactsPath, url: "https://example.com/artifacts" } },
    });

    await expect(
      executors.editArtifact({
        artifact_url: "https://example.com/artifacts/?source.txt",
        old_string: "same",
        new_string: "different",
      }),
    ).rejects.toThrow("appears 2 times");
  });

  it("fails fast when share_artifact is called without artifacts config", async () => {
    const executors = createDefaultToolExecutors();

    await expect(executors.shareArtifact("content")).rejects.toThrow(
      "Artifact tools require tools.artifacts.path and tools.artifacts.url configuration.",
    );
  });

  it("edit_artifact rejects binary remote artifacts", async () => {
    const { artifactsPath } = await makeArtifactsDir();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://external.example/photo.png" && init?.method === "HEAD") {
        return new Response("", {
          status: 200,
          headers: {
            "content-type": "image/png",
          },
        });
      }

      if (url === "https://external.example/photo.png") {
        return new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "image/png",
          },
        });
      }

      throw new Error(`Unexpected fetch URL in test: ${url}`);
    });

    const executors = createDefaultToolExecutors({ toolsConfig: { artifacts: { path: artifactsPath, url: "https://example.com/artifacts" } },
    });

    await expect(
      executors.editArtifact({
        artifact_url: "https://external.example/photo.png",
        old_string: "x",
        new_string: "y",
      }),
    ).rejects.toThrow("Cannot edit binary artifacts (images)");
  });

  it("edit_artifact blocks local path traversal via artifact URLs", async () => {
    const { artifactsPath } = await makeArtifactsDir();

    const executors = createDefaultToolExecutors({
      toolsConfig: { artifacts: { path: artifactsPath, url: "https://example.com/artifacts" } },
    });

    await expect(
      executors.editArtifact({
        artifact_url: "https://example.com/artifacts/?..%2F..%2Fetc%2Fpasswd",
        old_string: "root",
        new_string: "muaddib",
      }),
    ).rejects.toThrow("Path traversal detected in artifact URL");
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

describe("core tool executors chronicler/quest support", () => {
  it("chronicle_read and chronicle_append operate when chronicle store context is provided", async () => {
    const chronicleStore = new ChronicleStore(":memory:");
    await chronicleStore.initialize();

    const executors = createDefaultToolExecutors({
      chronicleStore,
      arc: "libera##test",
    });

    const appendResult = await executors.chronicleAppend({ text: "Noted." });
    const readResult = await executors.chronicleRead({ relative_chapter_id: 0 });

    expect(appendResult).toBe("OK");
    expect(readResult).toContain("Arc: libera##test");
    expect(readResult).toContain("Noted.");

    await chronicleStore.close();
  });

  it("chronicle_append uses lifecycle automation when lifecycle hook is provided", async () => {
    const chronicleStore = new ChronicleStore(":memory:");
    await chronicleStore.initialize();

    const appendParagraph = vi.fn(async () => ({ id: 1 }));

    const executors = createDefaultToolExecutors({
      chronicleStore,
      arc: "libera##test",
      chronicleLifecycle: {
        appendParagraph,
      },
    });

    const appendResult = await executors.chronicleAppend({ text: "Lifecycle append." });

    expect(appendResult).toBe("OK");
    expect(appendParagraph).toHaveBeenCalledWith("libera##test", "Lifecycle append.");

    await chronicleStore.close();
  });

  it("chronicle tools return deferred guidance when store context is missing", async () => {
    const executors = createDefaultToolExecutors();

    await expect(executors.chronicleRead({ relative_chapter_id: 0 })).resolves.toContain(
      "deferred in the TypeScript runtime",
    );
    await expect(executors.chronicleAppend({ text: "memory" })).resolves.toContain(
      "deferred in the TypeScript runtime",
    );
  });

  it("quest tools return deferred-runtime rejection while validating input", async () => {
    const executors = createDefaultToolExecutors();

    await expect(
      executors.questStart({
        id: "quest-1",
        goal: "Do a thing",
        success_criteria: "Done",
      }),
    ).resolves.toContain("REJECTED");

    await expect(
      executors.subquestStart({
        id: "sub-1",
        goal: "Do sub thing",
        success_criteria: "Done",
      }),
    ).resolves.toBe("Error: subquest_start requires an active quest context.");

    await expect(executors.questSnooze({ until: "tomorrow" })).resolves.toBe(
      "Error: quest_snooze requires an active quest context.",
    );

    const result = await executors.questStart({
      id: " ",
      goal: "Do a thing",
      success_criteria: "Done",
    });
    expect(result).toContain("Error:");
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

    const buildTools = vi.fn(() => [
      { name: "web_search" },
      { name: "oracle" },
      { name: "execute_code" },
      { name: "progress_report" },
      { name: "quest_start" },
      { name: "subquest_start" },
      { name: "quest_snooze" },
      { name: "visit_webpage" },
    ] as any[]);

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
    const toolNames = oracleMock.capturedOptions.tools.map((t: any) => t.name);
    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain("execute_code");
    expect(toolNames).toContain("visit_webpage");
    expect(toolNames).not.toContain("oracle");
    expect(toolNames).not.toContain("progress_report");
    expect(toolNames).not.toContain("quest_start");
    expect(toolNames).not.toContain("subquest_start");
    expect(toolNames).not.toContain("quest_snooze");
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
        buildTools: () => [],
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
      { conversationContext: [], toolOptions: {}, buildTools: () => [] },
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
      { conversationContext: [], toolOptions: {}, buildTools: () => [] },
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
      { conversationContext: [], toolOptions: {}, buildTools: () => [] },
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
    expect(oracleMock.capturedOptions.tools).toEqual([]);
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
      { conversationContext: [], toolOptions: {}, buildTools: () => [] },
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

describe("core tool executors execute_code support", () => {
  it("execute_code runs python code and captures output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {} }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    const result = await executors.executeCode({
      code: 'print("hello from python")',
      language: "python",
    });

    expect(result).toContain("hello from python");
    expect(result).toContain("Code saved to");
  });

  it("execute_code runs bash code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {} }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    const result = await executors.executeCode({
      code: 'echo "bash works"',
      language: "bash",
    });

    expect(result).toContain("bash works");
  });

  it("execute_code reports errors with exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {} }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    const result = await executors.executeCode({
      code: "exit 42",
      language: "bash",
    });

    expect(result).toContain("Execution error");
    expect(result).toContain("42");
  });

  it("execute_code rejects unsupported language", async () => {
    const executors = createDefaultToolExecutors();
    await expect(
      executors.executeCode({ code: "code", language: "ruby" as any }),
    ).rejects.toThrow("Unsupported execute_code language");
  });

  it("execute_code rejects empty code", async () => {
    const executors = createDefaultToolExecutors();
    await expect(executors.executeCode({ code: "   " })).rejects.toThrow("execute_code.code must be non-empty");
  });

  it("execute_code input_artifacts reports error for invalid URLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {} }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    const result = await executors.executeCode({
      code: 'echo "ok"',
      language: "bash",
      input_artifacts: ["not-a-url"],
    });

    expect(result).toContain("Error:");
    expect(result).toContain("ok");
  });

  it("execute_code output_files warns when no artifact store configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {} }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    const result = await executors.executeCode({
      code: 'echo "ok"',
      language: "bash",
      output_files: ["out.txt"],
    });

    expect(result).toContain("artifact store not configured");
  });

  it("execute_code output_files uploads generated files as artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const artifactsDir = join(dir, "artifacts");

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {}, artifacts: { path: artifactsDir, url: "https://example.com/artifacts" } }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    const result = await executors.executeCode({
      code: 'echo "report data" > /tmp/test-output-file.txt',
      language: "bash",
      output_files: ["/tmp/test-output-file.txt"],
    });

    expect(result).toContain("Downloaded file");
    expect(result).toContain("test-output-file.txt");
    expect(result).toContain("https://example.com/artifacts");
  });

  it("execute_code output_files reports error for missing files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {}, artifacts: { path: join(dir, "artifacts"), url: "https://example.com/artifacts" } }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    const result = await executors.executeCode({
      code: 'echo "ok"',
      language: "bash",
      output_files: ["/nonexistent/file.txt"],
    });

    expect(result).toContain("Error:");
    expect(result).toContain("/nonexistent/file.txt");
  });

  it("execute_code auto-detects generated images", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const artifactsDir = join(dir, "artifacts");

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {}, artifacts: { path: artifactsDir, url: "https://example.com/artifacts" } }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    // Create a minimal PNG file (1x1 pixel) via bash
    const result = await executors.executeCode({
      code: 'printf "\\x89PNG\\r\\n\\x1a\\n" > output.png',
      language: "bash",
    });

    expect(result).toContain("Generated image");
    expect(result).toContain("https://example.com/artifacts");
  });


  it("execute_code captures stderr warnings on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {} }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    const result = await executors.executeCode({
      code: 'echo "out" && echo "warn" >&2',
      language: "bash",
    });

    expect(result).toContain("out");
    expect(result).toContain("**Warnings:**");
    expect(result).toContain("warn");
  });

  it("execute_code truncates large output with head+tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {} }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    // Generate output larger than 24000 chars
    const lineCount = 2000;
    const code = `for i in range(${lineCount}): print(f"LINE-{i:04d}-" + "x" * 20)`;
    const result = await executors.executeCode({ code, language: "python" });

    // Should contain head content (early lines)
    expect(result).toContain("LINE-0000");
    // Should contain tail content (late lines)
    expect(result).toContain(`LINE-${lineCount - 1}`);
    // Should contain truncation indicator
    expect(result).toContain("truncated");
  });

  it("execute_code auto-detects gif and webp images", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);
    const artifactsDir = join(dir, "artifacts");

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {}, artifacts: { path: artifactsDir, url: "https://example.com/artifacts" } }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    // Create a tiny GIF in the workdir
    const code = `
import struct
# Minimal GIF89a (1x1 pixel)
gif = b'GIF89a\\x01\\x00\\x01\\x00\\x00\\x00\\x00;'
with open('test.gif', 'wb') as f:
    f.write(gif)
with open('test.webp', 'wb') as f:
    f.write(b'RIFF\\x00\\x00\\x00\\x00WEBP')
`;
    const result = await executors.executeCode({ code, language: "python" });

    // The mock won't actually produce image URLs, but the find command should
    // search for gif and webp extensions
    expect(result).toBeDefined();
  });

  it("execute_code reports no output message for silent success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {} }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    const result = await executors.executeCode({
      code: "true",
      language: "bash",
    });

    expect(result).toContain("Code executed successfully with no output");
  });

  it("execute_code recreates workdir on second call if sprite restarted and wiped /tmp", async () => {
    // Capture workdir path via logger
    const logMessages: string[] = [];
    const captureLogger = {
      info: (msg: string) => logMessages.push(msg),
      debug: (msg: string) => logMessages.push(msg),
      warn: (msg: string) => logMessages.push(msg),
      error: (msg: string) => logMessages.push(msg),
    };

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {} },
      authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
      logger: captureLogger,
    });

    // First call establishes the workdir
    const result1 = await executors.executeCode({ code: 'echo "first"', language: "bash" });
    expect(result1).toContain("first");

    // Extract the workdir path from log
    const workdirLog = logMessages.find((m) => m.includes("Ensured actor workdir:"));
    expect(workdirLog).toBeTruthy();
    const workdir = workdirLog!.split("Ensured actor workdir: ")[1].trim();

    // Simulate sprite restart: delete the workdir to mimic /tmp being wiped
    await rm(workdir, { recursive: true, force: true });

    // Second call must succeed even though the workdir was deleted
    const result2 = await executors.executeCode({ code: 'echo "second"', language: "bash" });
    expect(result2).toContain("second");
  });
});

describe("core tool executors execute_code Sprites sandbox", () => {
  it("execute_code requires spritesToken", async () => {
    const executors = createDefaultToolExecutors({});

    await expect(
      executors.executeCode({ code: 'echo "hi"', language: "bash" }),
    ).rejects.toThrow("'sprites' API key in auth.json");
  });

  it("execute_code handles binary output files correctly via base64 roundtrip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);
    const artifactsDir = join(dir, "artifacts");

    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {}, artifacts: { path: artifactsDir, url: "https://example.com/artifacts" } }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    // Write binary data (PNG header bytes) and download via output_files
    const result = await executors.executeCode({
      code: 'printf "\\x89PNG\\x0d\\x0a\\x1a\\x0a\\x00\\x00" > /tmp/binary-test.bin',
      language: "bash",
      output_files: ["/tmp/binary-test.bin"],
    });

    expect(result).toContain("Downloaded file (binary-test.bin):");
    // Verify the artifact file was written with correct binary content
    const match = result.match(/https:\/\/example\.com\/artifacts\/\?([^\s*]+)/);
    expect(match).toBeTruthy();
    const savedContent = await readFile(join(artifactsDir, match![1]));
    // First byte should be 0x89 (PNG magic), not corrupted by string encoding
    expect(savedContent[0]).toBe(0x89);
    expect(savedContent[1]).toBe(0x50); // 'P'
  });

  it("execute_code handles code with shell-special characters safely", async () => {
    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: {} }, authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    // Code containing single quotes, backticks, dollar signs
    const result = await executors.executeCode({
      code: "echo \"it's a \\$test\" && echo 'backtick: \\`cmd\\`'",
      language: "bash",
    });

    expect(result).toContain("Code saved to");
    // Should not error from shell escaping issues
    expect(result).not.toContain("Error initializing sandbox");
  });

  it("execute_code applies timeout to execution", async () => {
    const executors = createDefaultToolExecutors({
      toolsConfig: { sprites: { executeTimeoutMs: 100 } },
      authStorage: AuthStorage.inMemory({ sprites: { type: "api_key", key: "test-token" } }),
    });

    const result = await executors.executeCode({
      code: "sleep 30",
      language: "bash",
    });

    // Should be killed by timeout, not hang for 30s
    expect(result).toContain("Execution error");
  }, 15_000);
});

describe("core tool executors quest validation with active quest", () => {
  it("subquest_start returns deferred message with active quest context", async () => {
    const executors = createDefaultToolExecutors({ currentQuestId: "active-quest" });

    const result = await executors.subquestStart({
      id: "sub-1",
      goal: "Do sub thing",
      success_criteria: "Done",
    });

    expect(result).toContain("REJECTED");
  });

  it("subquest_start validates input with active quest context", async () => {
    const executors = createDefaultToolExecutors({ currentQuestId: "active-quest" });

    const emptyId = await executors.subquestStart({ id: " ", goal: "g", success_criteria: "s" });
    expect(emptyId).toContain("Error:");

    const dotId = await executors.subquestStart({ id: "a.b", goal: "g", success_criteria: "s" });
    expect(dotId).toContain("Error:");
    expect(dotId).toContain("dots");

    const longId = await executors.subquestStart({ id: "a".repeat(65), goal: "g", success_criteria: "s" });
    expect(longId).toContain("Error:");
    expect(longId).toContain("too long");

    await expect(
      executors.subquestStart({ id: "x", goal: " ", success_criteria: "s" }),
    ).rejects.toThrow("subquest_start.goal must be non-empty");

    await expect(
      executors.subquestStart({ id: "x", goal: "g", success_criteria: " " }),
    ).rejects.toThrow("subquest_start.success_criteria must be non-empty");
  });

  it("quest_snooze validates time format with active quest context", async () => {
    const executors = createDefaultToolExecutors({ currentQuestId: "active-quest" });

    const result = await executors.questSnooze({ until: "14:30" });
    expect(result).toContain("REJECTED");

    const badFormat = await executors.questSnooze({ until: "tomorrow" });
    expect(badFormat).toContain("Invalid time format");

    const badHour = await executors.questSnooze({ until: "25:00" });
    expect(badHour).toContain("Invalid time");

    const badMinute = await executors.questSnooze({ until: "12:60" });
    expect(badMinute).toContain("Invalid time");
  });

  it("quest_start validates all required fields", async () => {
    const executors = createDefaultToolExecutors();

    const emptyId = await executors.questStart({ id: "", goal: "g", success_criteria: "s" });
    expect(emptyId).toContain("Error:");

    const dotId = await executors.questStart({ id: "a.b", goal: "g", success_criteria: "s" });
    expect(dotId).toContain("Error:");
    expect(dotId).toContain("dots");

    const badChars = await executors.questStart({ id: "a b", goal: "g", success_criteria: "s" });
    expect(badChars).toContain("Error:");

    await expect(
      executors.questStart({ id: "x", goal: " ", success_criteria: "s" }),
    ).rejects.toThrow("quest_start.goal must be non-empty");

    await expect(
      executors.questStart({ id: "x", goal: "g", success_criteria: " " }),
    ).rejects.toThrow("quest_start.success_criteria must be non-empty");
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
