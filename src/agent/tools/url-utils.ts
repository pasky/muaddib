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
 * Check if a URL looks like an image based on file extension.
 */
export function looksLikeImageUrl(url: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i.test(url);
}
