import { relative, resolve } from "node:path";

/**
 * Shared URL/filename utilities for artifact and web tools.
 */

/**
 * Extract a filename from a URL, checking query parameters first, then the path.
 */
export function extractFilenameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const queryFilename = extractFilenameFromQuery(parsed.search.slice(1));
    if (queryFilename) return queryFilename;

    const decodedPath = decodeURIComponent(parsed.pathname);
    if (!decodedPath || decodedPath.endsWith("/")) return undefined;

    const leaf = decodedPath.split("/").pop();
    if (!leaf || leaf === "index.html") return undefined;

    return leaf;
  } catch {
    return undefined;
  }
}

/**
 * Extract a filename from a query string. Supports bare `?filename` and `?file=filename` styles.
 */
export function extractFilenameFromQuery(query: string): string | undefined {
  if (!query) return undefined;

  if (query.includes("=")) {
    const params = new URLSearchParams(query);
    for (const key of ["file", "filename"]) {
      const value = params.get(key)?.trim();
      if (value) return decodeURIComponent(value);
    }
    return undefined;
  }

  const value = decodeURIComponent(query.trim());
  return value || undefined;
}

/**
 * Extract the artifact-relative path from a URL that matches the artifacts base URL.
 * Handles both raw paths and `?filename` / `index.html?filename` query styles.
 */
export function extractLocalArtifactPath(url: string, artifactsUrl: string | undefined): string | undefined {
  if (!artifactsUrl) return undefined;

  const base = artifactsUrl.replace(/\/+$/, "");
  if (url !== base && !url.startsWith(base + "/") && !url.startsWith(base + "?")) {
    return undefined;
  }

  let remainder = url.slice(base.length);
  if (remainder.startsWith("/")) remainder = remainder.slice(1);

  if (remainder.startsWith("?")) {
    return extractFilenameFromQuery(remainder.slice(1));
  }

  if (remainder.startsWith("index.html?")) {
    return extractFilenameFromQuery(remainder.slice("index.html?".length));
  }

  if (remainder.includes("?")) {
    const [pathPart, query] = remainder.split("?", 2);
    if (pathPart === "index.html") {
      return extractFilenameFromQuery(query);
    }
  }

  if (!remainder) return undefined;
  return decodeURIComponent(remainder);
}

/**
 * Resolve a local artifact URL to an on-disk file path under the configured artifact directory.
 * Returns undefined when the URL does not belong to the configured artifact base URL.
 */
export function resolveLocalArtifactFilePath(
  url: string,
  artifactsUrl: string | undefined,
  artifactsPath: string | undefined,
): string | undefined {
  if (!artifactsUrl || !artifactsPath) return undefined;

  const relativePath = extractLocalArtifactPath(url, artifactsUrl);
  if (!relativePath) return undefined;

  const resolvedBase = resolve(artifactsPath);
  const filePath = resolve(resolvedBase, relativePath);
  const rel = relative(resolvedBase, filePath);

  if (rel.startsWith("..") || filePath !== resolve(resolvedBase, rel || ".")) {
    throw new Error("Path traversal detected");
  }

  return filePath;
}
