import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolContext } from "./types.js";

const ARTIFACT_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ARTIFACT_VIEWER_HTML = loadArtifactViewerHtml();

function loadArtifactViewerHtml(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    join(moduleDir, "artifact-viewer.html"),
    join(moduleDir, "../../../src/agent/tools/artifact-viewer.html"),
  ];

  for (const candidatePath of candidatePaths) {
    try {
      return readFileSync(candidatePath, "utf-8");
    } catch {
      // Recovery strategy: fallback to next candidate path.
    }
  }

  throw new Error(
    `Failed to load artifact viewer HTML. Checked: ${candidatePaths.join(", ")}`,
  );
}

export async function writeArtifactText(
  options: ToolContext,
  content: string,
  suffix: string,
): Promise<string> {
  return writeArtifact(options, content, suffix, "utf-8");
}

export async function writeArtifactBytes(
  options: ToolContext,
  data: Buffer,
  suffix: string,
): Promise<string> {
  return writeArtifact(options, data, suffix);
}

async function writeArtifact(
  options: ToolContext,
  data: string | Buffer,
  suffix: string,
  encoding?: BufferEncoding,
): Promise<string> {
  const artifactsPath = options.toolsConfig?.artifacts?.path;
  const artifactsUrl = options.toolsConfig?.artifacts?.url;

  if (!artifactsPath || !artifactsUrl) {
    throw new Error("Artifact tools require tools.artifacts.path and tools.artifacts.url configuration.");
  }

  await ensureArtifactsDirectory(artifactsPath);

  const artifactId = generateArtifactId();
  const normalizedSuffix = suffix.startsWith(".") ? suffix : `.${suffix}`;
  const filename = `${artifactId}${normalizedSuffix}`;
  const filePath = join(artifactsPath, filename);

  await writeFile(filePath, data, encoding);
  options.logger?.info(`Created artifact file: ${filePath}`);

  return toArtifactViewerUrl(artifactsUrl, filename);
}

/** Track directories where index.html has already been written this process. */
const indexWrittenPaths = new Set<string>();

async function ensureArtifactsDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });

  if (indexWrittenPaths.has(path)) return;

  const indexPath = join(path, "index.html");
  await writeFile(indexPath, ARTIFACT_VIEWER_HTML, "utf-8");
  indexWrittenPaths.add(path);
}

function toArtifactViewerUrl(baseUrl: string, filename: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/?${encodeURIComponent(filename)}`;
}

function generateArtifactId(length = 8): string {
  const bytes = randomBytes(length);
  let id = "";

  for (let i = 0; i < length; i += 1) {
    id += ARTIFACT_ID_ALPHABET[bytes[i] % ARTIFACT_ID_ALPHABET.length];
  }

  return id;
}
