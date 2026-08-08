import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ArtifactContext } from "./types.js";

const ARTIFACT_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Extensions Apache may execute server-side (mod_php family). Publishing
 * these would yield a broken URL — the .htaccess hardening denies them —
 * or worse, execute wherever the deny is missing. Keep in sync with the
 * FilesMatch in artifact-htaccess.
 */
const EXECUTABLE_SUFFIX = /\.(?:php\d*|phar|phps|phtml|pht)$/i;
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
  return writeArtifact(options, content, suffix);
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
): Promise<string> {
  const artifactsPath = options.toolsConfig?.artifacts?.path;
  const artifactsUrl = options.toolsConfig?.artifacts?.url;

  if (!artifactsPath || !artifactsUrl) {
    throw new Error("Artifact tools require tools.artifacts.path and tools.artifacts.url configuration.");
  }

  await ensureArtifactsDirectory(artifactsPath);

  const artifactId = generateArtifactId();
  const normalizedSuffix = suffix.startsWith(".") ? suffix : `.${suffix}`;

  if (EXECUTABLE_SUFFIX.test(normalizedSuffix)) {
    throw new Error(
      `Refusing to publish artifact with server-executable extension "${normalizedSuffix}". ` +
        `Rename it to an inert name (e.g. "${normalizedSuffix}.txt") so it is served as plain text.`,
    );
  }

  const filename = `${artifactId}${normalizedSuffix}`;
  const filePath = join(artifactsPath, filename);

  await writeFileAtomic(filePath, data);
  options.logger?.info(`Created artifact file: ${filePath}`);

  return toArtifactViewerUrl(artifactsUrl, filename);
}

export async function ensureArtifactsDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  // (Re)written on every publish and at startup so neither the viewer nor
  // the hardening can go stale or stay silently removed between runs.
  await writeFileAtomic(join(path, "index.html"), ARTIFACT_VIEWER_HTML);
  await writeFileAtomic(join(path, ".htaccess"), ARTIFACT_HTACCESS);
}

/** Write via a temp file + rename so a partial file is never served. */
async function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tempPath, data);
  await rename(tempPath, path);
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
