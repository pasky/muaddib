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
