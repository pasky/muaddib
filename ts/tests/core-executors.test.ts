import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultToolExecutors } from "../src/agent/tools/core-executors.js";

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
    expect(indexHtml).toContain("Muaddib Artifact Viewer");
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
