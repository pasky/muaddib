import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ArtifactContext } from "./types.js";

const ARTIFACT_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ARTIFACT_VIEWER_HTML = loadToolAsset("artifact-viewer.html");
const ARTIFACT_HTACCESS = loadToolAsset("artifact-htaccess");

function loadToolAsset(filename: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    join(moduleDir, filename),
    join(moduleDir, "../../../src/agent/tools", filename),
  ];

  for (const candidatePath of candidatePaths) {
    try {
      return readFileSync(candidatePath, "utf-8");
    } catch {
      // Recovery strategy: fallback to next candidate path.
    }
  }

  throw new Error(
    `Failed to load ${filename}. Checked: ${candidatePaths.join(", ")}`,
  );
}

export async function writeArtifactText(
  options: ArtifactContext,
  content: string,
  suffix: string,
): Promise<string> {
  return writeArtifact(options, content, suffix, "utf-8");
}

export async function writeArtifactBytes(
  options: ArtifactContext,
  data: Buffer,
  suffix: string,
): Promise<string> {
  return writeArtifact(options, data, suffix);
}

async function writeArtifact(
  options: ArtifactContext,
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

/** Track directories where the bootstrap files have already been written this process. */
const bootstrappedPaths = new Set<string>();

async function ensureArtifactsDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });

  if (bootstrappedPaths.has(path)) return;

  await writeFile(join(path, "index.html"), ARTIFACT_VIEWER_HTML, "utf-8");
  // Hardening is always (re)written so the script-execution deny cannot go
  // stale on deployments that already have an older .htaccess in place.
  await writeFile(join(path, ".htaccess"), ARTIFACT_HTACCESS, "utf-8");
  bootstrappedPaths.add(path);
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
