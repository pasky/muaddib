import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultToolExecutors } from "../src/agent/tools/core-executors.js";
import { ChronicleStore } from "../src/chronicle/chronicle-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
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

function assistantTextMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

describe("core tool executors artifact support", () => {
  it("share_artifact writes text artifact and returns viewer URL", async () => {
    const { artifactsPath } = await makeArtifactsDir();

    const executors = createDefaultToolExecutors({
      artifactsPath,
      artifactsUrl: "https://example.com/artifacts",
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
  });

  it("edit_artifact edits local artifact and preserves extension in derived artifact", async () => {
    const { artifactsPath } = await makeArtifactsDir();

    await writeFile(join(artifactsPath, "source.py"), "def answer():\n    return 41\n", "utf-8");

    const executors = createDefaultToolExecutors({
      artifactsPath,
      artifactsUrl: "https://example.com/artifacts",
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
      artifactsPath,
      artifactsUrl: "https://example.com/artifacts",
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
      artifactsPath,
      artifactsUrl: "https://example.com/artifacts",
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

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    }) as typeof fetch;

    const executors = createDefaultToolExecutors({
      fetchImpl,
      artifactsPath,
      artifactsUrl: "https://example.com/artifacts",
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
      artifactsPath,
      artifactsUrl: "https://example.com/artifacts",
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

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      fetchImpl: fetchImpl as unknown as typeof fetch,
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
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([privateUrl, privateUrl]);
  });
});

describe("core tool executors chronicler/quest support", () => {
  it("chronicle_read and chronicle_append operate when chronicle store context is provided", async () => {
    const chronicleStore = new ChronicleStore(":memory:");
    await chronicleStore.initialize();

    const executors = createDefaultToolExecutors({
      chronicleStore,
      chronicleArc: "libera##test",
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
      chronicleArc: "libera##test",
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

    await expect(
      executors.questStart({
        id: " ",
        goal: "Do a thing",
        success_criteria: "Done",
      }),
    ).rejects.toThrow("quest_start.id must be non-empty.");
  });
});

describe("core tool executors oracle support", () => {
  it("oracle executes configured model and returns text output", async () => {
    const completeSimpleFn = vi.fn(async (_model: any, _context: any, _options?: any) => assistantTextMessage("oracle answer"));
    const getApiKey = vi.fn(async (provider: string) => {
      return provider === "openai" ? "openai-key" : undefined;
    });

    const executors = createDefaultToolExecutors({
      oracleModel: "openai:gpt-4o-mini",
      oraclePrompt: "You are an oracle.",
      completeSimpleFn,
      getApiKey,
    });

    const result = await executors.oracle({
      query: "How should this migration be staged?",
    });

    expect(result).toBe("oracle answer");
    expect(getApiKey).toHaveBeenCalledWith("openai");

    const completeCall = completeSimpleFn.mock.calls[0];
    expect(completeCall[1]).toMatchObject({
      systemPrompt: "You are an oracle.",
      messages: [
        {
          role: "user",
          content: "How should this migration be staged?",
        },
      ],
    });
    expect(completeCall[2]).toMatchObject({ apiKey: "openai-key", reasoning: "high" });
  });

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
      oracleModel: "openai:gpt-4o-mini",
      completeSimpleFn: vi.fn(async () => assistantTextMessage("irrelevant")),
    });

    await expect(
      executors.oracle({
        query: "   ",
      }),
    ).rejects.toThrow("oracle.query must be non-empty.");
  });
});

describe("core tool executors web_search support", () => {
  it("web_search returns formatted search results", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("s.jina.ai");
      expect(url).toContain("cats");
      return new Response("Title: Cats\nURL: https://example.com\nSnippet: All about cats", { status: 200 });
    }) as typeof fetch;

    const executors = createDefaultToolExecutors({ fetchImpl });
    const result = await executors.webSearch("cats");
    expect(result).toContain("## Search Results");
    expect(result).toContain("All about cats");
  });

  it("web_search returns friendly message for no results (422)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("No search results available for query", { status: 422 }),
    ) as typeof fetch;

    const executors = createDefaultToolExecutors({ fetchImpl });
    const result = await executors.webSearch("xyznonexistent");
    expect(result).toBe("No search results found. Try a different query.");
  });

  it("web_search returns friendly message for empty body", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 })) as typeof fetch;
    const executors = createDefaultToolExecutors({ fetchImpl });
    const result = await executors.webSearch("something");
    expect(result).toBe("No search results found. Try a different query.");
  });

  it("web_search throws on non-422 error", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("Server error", { status: 500 }),
    ) as typeof fetch;

    const executors = createDefaultToolExecutors({ fetchImpl });
    await expect(executors.webSearch("test")).rejects.toThrow("Search failed: Jina HTTP 500");
  });

  it("web_search validates non-empty query", async () => {
    const executors = createDefaultToolExecutors({ fetchImpl: vi.fn() as typeof fetch });
    await expect(executors.webSearch("   ")).rejects.toThrow("web_search.query must be non-empty");
  });

  it("web_search passes Jina API key as Bearer token when configured", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer jina-key-123");
      return new Response("results", { status: 200 });
    }) as typeof fetch;

    const executors = createDefaultToolExecutors({ fetchImpl, jinaApiKey: "jina-key-123" });
    await executors.webSearch("test");
  });
});

describe("core tool executors visit_webpage support", () => {
  it("visit_webpage fetches page content via Jina reader", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.startsWith("https://r.jina.ai/")) {
        return new Response("# Page Title\nSome content", { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const executors = createDefaultToolExecutors({ fetchImpl });
    const result = await executors.visitWebpage("https://example.com/page");
    expect(result).toContain("## Content from https://example.com/page");
    expect(result).toContain("Some content");
  });

  it("visit_webpage downloads images and returns binary result", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response(Uint8Array.from([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch;

    const executors = createDefaultToolExecutors({ fetchImpl });
    const result = await executors.visitWebpage("https://example.com/img.png");
    expect(typeof result).toBe("object");
    expect((result as any).kind).toBe("image");
    expect((result as any).mimeType).toBe("image/png");
  });

  it("visit_webpage rejects non-http URLs", async () => {
    const executors = createDefaultToolExecutors({ fetchImpl: vi.fn() as typeof fetch });
    await expect(executors.visitWebpage("ftp://example.com/file")).rejects.toThrow("Invalid URL");
  });

  it("visit_webpage truncates long content", async () => {
    const longContent = "x".repeat(50000);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(longContent, { status: 200 });
    }) as typeof fetch;

    const executors = createDefaultToolExecutors({ fetchImpl, maxWebContentLength: 1000 });
    const result = await executors.visitWebpage("https://example.com");
    expect(result).toContain("..._Content truncated_...");
    expect((result as string).length).toBeLessThan(5000);
  });

  it("visit_webpage returns empty response marker for empty body", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const executors = createDefaultToolExecutors({ fetchImpl });
    const result = await executors.visitWebpage("https://example.com");
    expect(result).toContain("(Empty response)");
  });

  it("visit_webpage rejects oversized images", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response(new Uint8Array(5000), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch;

    const executors = createDefaultToolExecutors({ fetchImpl, maxImageBytes: 1000 });
    await expect(executors.visitWebpage("https://example.com/big.png")).rejects.toThrow("Image too large");
  });
});

describe("core tool executors execute_code support", () => {
  it("execute_code runs python code and captures output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      executeCodeWorkingDirectory: join(dir, "work"),
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
      executeCodeWorkingDirectory: join(dir, "work"),
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
      executeCodeWorkingDirectory: join(dir, "work"),
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

  it("execute_code warns about unsupported input/output artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      executeCodeWorkingDirectory: join(dir, "work"),
    });

    const result = await executors.executeCode({
      code: 'echo "ok"',
      language: "bash",
      input_artifacts: ["file.txt"],
      output_files: ["out.txt"],
    });

    expect(result).toContain("input_artifacts are not yet supported");
    expect(result).toContain("output_files are not yet supported");
  });

  it("execute_code handles timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      executeCodeWorkingDirectory: join(dir, "work"),
      executeCodeTimeoutMs: 200,
    });

    // Use a bash busy-wait that responds to SIGKILL immediately
    const result = await executors.executeCode({
      code: "while true; do :; done",
      language: "bash",
    });

    expect(result).toContain("Timed out");
  }, 10_000);

  it("execute_code captures stderr warnings on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      executeCodeWorkingDirectory: join(dir, "work"),
    });

    const result = await executors.executeCode({
      code: 'echo "out" && echo "warn" >&2',
      language: "bash",
    });

    expect(result).toContain("out");
    expect(result).toContain("**Warnings:**");
    expect(result).toContain("warn");
  });

  it("execute_code reports no output message for silent success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
    tempDirs.push(dir);

    const executors = createDefaultToolExecutors({
      executeCodeWorkingDirectory: join(dir, "work"),
    });

    const result = await executors.executeCode({
      code: "true",
      language: "bash",
    });

    expect(result).toContain("Code executed successfully with no output");
  });
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

    await expect(
      executors.subquestStart({ id: " ", goal: "g", success_criteria: "s" }),
    ).rejects.toThrow("subquest_start.id must be non-empty");

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

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://assets.example/ref.png") {
        return new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "image/png",
          },
        });
      }

      if (url === "https://openrouter.example/api/v1/chat/completions") {
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
    }) as typeof fetch;

    const executors = createDefaultToolExecutors({
      fetchImpl,
      artifactsPath,
      artifactsUrl: "https://example.com/artifacts",
      imageGenModel: "openrouter:google/gemini-3-pro-image-preview",
      openRouterBaseUrl: "https://openrouter.example/api/v1",
      getApiKey: async (provider: string) => {
        return provider === "openrouter" ? "or-key" : undefined;
      },
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
    ).rejects.toThrow("generate_image tool requires tools.image_gen.model configuration.");
  });

  it("generate_image rejects non-openrouter model providers", async () => {
    const executors = createDefaultToolExecutors({
      imageGenModel: "openai:gpt-image-1",
      getApiKey: async () => "demo",
    });

    await expect(
      executors.generateImage({
        prompt: "Draw a cat",
      }),
    ).rejects.toThrow("tools.image_gen.model must use openrouter provider");
  });

  it("generate_image errors when OpenRouter returns no images", async () => {
    const { artifactsPath } = await makeArtifactsDir();

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "https://openrouter.example/api/v1/chat/completions") {
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
    }) as typeof fetch;

    const executors = createDefaultToolExecutors({
      fetchImpl,
      artifactsPath,
      artifactsUrl: "https://example.com/artifacts",
      imageGenModel: "openrouter:google/gemini-3-pro-image-preview",
      openRouterBaseUrl: "https://openrouter.example/api/v1",
      getApiKey: async () => "or-key",
    });

    await expect(
      executors.generateImage({
        prompt: "Draw a cat",
      }),
    ).rejects.toThrow("Image generation failed: No images generated by model.");
  });
});
