import { readFile } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";

import { Type } from "@sinclair/typebox";

import type { DefaultToolExecutorOptions, MuaddibTool } from "./types.js";

export interface VisitWebpageImageResult {
  kind: "image";
  data: string;
  mimeType: string;
}

export type VisitWebpageResult = string | VisitWebpageImageResult;

export type WebSearchExecutor = (query: string) => Promise<string>;
export type VisitWebpageExecutor = (url: string) => Promise<VisitWebpageResult>;

const DEFAULT_WEB_CONTENT_LIMIT = 40_000;
const DEFAULT_IMAGE_LIMIT = 3_500_000;

/** Jina reader retry config. Mutable for test override. */
export const jinaRetryConfig = { delaysMs: [0, 30_000, 90_000] };

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function createWebSearchTool(executors: { webSearch: WebSearchExecutor }): MuaddibTool {
  return {
    name: "web_search",
    persistType: "summary",
    label: "Web Search",
    description: "Search the web and return top results with titles, URLs, and descriptions.",
    parameters: Type.Object({
      query: Type.String({
        description: "The search query to perform.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const output = await executors.webSearch(params.query);
      return {
        content: [{ type: "text", text: output }],
        details: {
          query: params.query,
        },
      };
    },
  };
}

export function createVisitWebpageTool(
  executors: { visitWebpage: VisitWebpageExecutor },
): MuaddibTool {
  return {
    name: "visit_webpage",
    persistType: "summary",
    label: "Visit Webpage",
    description:
      "Visit the given URL and return content as markdown text, or as image content for image URLs.",
    parameters: Type.Object({
      url: Type.String({
        format: "uri",
        description: "The URL to visit.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const output = await executors.visitWebpage(params.url);
      return toolResultFromVisitWebpageOutput(params.url, output);
    },
  };
}

/**
 * Simple rate limiter that ensures a minimum interval between calls.
 */
class RateLimiter {
  private lastCallTime = 0;
  private readonly minIntervalMs: number;

  constructor(maxCallsPerSecond = 1.0) {
    this.minIntervalMs = maxCallsPerSecond > 0 ? 1000 / maxCallsPerSecond : 0;
  }

  async waitIfNeeded(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastCallTime = Date.now();
  }

  reset(): void {
    this.lastCallTime = 0;
  }
}

// Shared rate limiters for web tools (per-process singletons).
const searchRateLimiter = new RateLimiter(1.0);
const visitRateLimiter = new RateLimiter(1.0);

/** Reset rate limiter state (for tests). */
export function resetWebRateLimiters(): void {
  searchRateLimiter.reset();
  visitRateLimiter.reset();
}

export function createDefaultWebSearchExecutor(
  options: DefaultToolExecutorOptions,
): WebSearchExecutor {
  const fetchImpl = getFetch(options);

  return async (query: string): Promise<string> => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new Error("web_search.query must be non-empty.");
    }

    await searchRateLimiter.waitIfNeeded();

    const url = `https://s.jina.ai/?q=${encodeURIComponent(trimmedQuery)}`;
    const response = await fetchImpl(url, {
      headers: buildJinaHeaders(options.jinaApiKey, {
        "X-Respond-With": "no-content",
      }),
    });

    const body = (await response.text()).trim();
    if (response.status === 422 && body.includes("No search results available for query")) {
      return "No search results found. Try a different query.";
    }

    if (!response.ok) {
      throw new Error(`Search failed: Jina HTTP ${response.status}: ${body}`);
    }

    if (!body) {
      return "No search results found. Try a different query.";
    }

    return `## Search Results\n\n${body}`;
  };
}

export function createDefaultVisitWebpageExecutor(
  options: DefaultToolExecutorOptions,
): VisitWebpageExecutor {
  const fetchImpl = getFetch(options);
  const maxWebContentLength = options.maxWebContentLength ?? DEFAULT_WEB_CONTENT_LIMIT;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_IMAGE_LIMIT;

  return async (url: string): Promise<VisitWebpageResult> => {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Invalid URL. Must start with http:// or https://");
    }

    // Check if this is a local artifact we can read directly from disk.
    const localResult = await tryReadLocalArtifact(options, url, maxWebContentLength, maxImageBytes);
    if (localResult !== null) {
      return localResult;
    }

    await visitRateLimiter.waitIfNeeded();

    const requestHeaders = buildVisitHeaders(options, url, {
      "User-Agent": "muaddib/1.0",
    });

    let contentType = "";
    try {
      const headResponse = await fetchImpl(url, {
        method: "HEAD",
        headers: requestHeaders,
      });
      if (headResponse.ok) {
        contentType = (headResponse.headers.get("content-type") ?? "").toLowerCase();
      }
    } catch {
      // Recovery strategy: some sites disallow HEAD; continue with reader fallback.
    }

    if (contentType.startsWith("image/") || looksLikeImageUrl(url)) {
      const imageResponse = await fetchImpl(url, {
        headers: requestHeaders,
      });
      if (!imageResponse.ok) {
        throw new Error(`Failed to download image: HTTP ${imageResponse.status}`);
      }

      const imageMimeType =
        (imageResponse.headers.get("content-type") ?? "image/png").split(";")[0].trim();
      const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
      if (imageBytes.length > maxImageBytes) {
        throw new Error(
          `Image too large (${imageBytes.length} bytes). Maximum allowed: ${maxImageBytes} bytes`,
        );
      }

      return {
        kind: "image",
        data: imageBytes.toString("base64"),
        mimeType: imageMimeType,
      };
    }

    const hasAuthHeaders = Object.entries(requestHeaders).some(
      ([key, value]) => key.toLowerCase() !== "user-agent" && String(value).trim().length > 0,
    );

    if (hasAuthHeaders) {
      const response = await fetchImpl(url, {
        headers: requestHeaders,
      });

      if (!response.ok) {
        const errorBody = (await response.text()).trim();
        throw new Error(`visit_webpage failed: HTTP ${response.status}: ${errorBody}`);
      }

      const rawContentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const isTextLike =
        rawContentType.startsWith("text/") ||
        rawContentType.includes("json") ||
        rawContentType.includes("xml") ||
        rawContentType.includes("javascript");

      if (!isTextLike && rawContentType && !rawContentType.startsWith("image/")) {
        // Binary content — return as base64.
        const data = Buffer.from(await response.arrayBuffer());
        const truncated = data.length > maxWebContentLength;
        const slice = truncated ? data.subarray(0, maxWebContentLength) : data;
        const b64 = slice.toString("base64");
        const suffix = truncated ? " (truncated)" : "";
        return `## Binary content from ${url} (content-type: ${rawContentType})\n\nBase64${suffix}: ${b64}`;
      }

      const body = (await response.text()).trim();

      if (!body) {
        return `## Content from ${url}\n\n(Empty response)`;
      }

      return formatTextContent(url, body, maxWebContentLength);
    }

    // Use Jina reader with retry/backoff.
    const readerUrl = `https://r.jina.ai/${url}`;
    const body = await fetchJinaWithRetry(fetchImpl, readerUrl, options.jinaApiKey, options.logger);

    if (!body) {
      return `## Content from ${url}\n\n(Empty response)`;
    }

    return formatTextContent(url, body, maxWebContentLength);
  };
}

/**
 * Try to read a URL as a local artifact from disk. Returns null if the URL
 * does not match the configured artifacts URL.
 */
async function tryReadLocalArtifact(
  options: DefaultToolExecutorOptions,
  url: string,
  maxContentLength: number,
  maxImageBytes: number,
): Promise<VisitWebpageResult | null> {
  const { artifactsPath, artifactsUrl } = options;
  if (!artifactsPath || !artifactsUrl) return null;

  const filename = extractLocalArtifactPath(url, artifactsUrl);
  if (!filename) return null;

  // Resolve and validate no path traversal.
  const filePath = resolve(artifactsPath, filename);
  const resolvedBase = resolve(artifactsPath);
  const rel = relative(resolvedBase, filePath);
  if (rel.startsWith("..") || resolve(resolvedBase, rel) !== filePath) {
    throw new Error("Path traversal detected");
  }

  const ext = extname(filePath).toLowerCase();
  const imageMime = IMAGE_EXTENSIONS[ext];

  if (imageMime) {
    const data = await readFile(filePath);
    if (data.length > maxImageBytes) {
      throw new Error(`Image too large: ${data.length} bytes`);
    }
    return { kind: "image", data: data.toString("base64"), mimeType: imageMime };
  }

  // Text file.
  const data = await readFile(filePath, "utf-8");
  if (data.length > maxContentLength) {
    return data.slice(0, maxContentLength) + "\n\n..._Content truncated_...";
  }
  return data;
}

/**
 * Extract the artifact-relative path from a URL that matches the artifacts base URL.
 * Handles both raw paths and `?filename` / `index.html?filename` query styles.
 */
function extractLocalArtifactPath(url: string, artifactsUrl: string): string | null {
  const base = artifactsUrl.replace(/\/+$/, "");
  if (url !== base && !url.startsWith(base + "/") && !url.startsWith(base + "?")) {
    return null;
  }

  let remainder = url.slice(base.length);
  if (remainder.startsWith("/")) remainder = remainder.slice(1);

  // ?filename style
  if (remainder.startsWith("?")) {
    return extractFilenameFromQuery(remainder.slice(1));
  }

  // index.html?filename style
  if (remainder.startsWith("index.html?")) {
    return extractFilenameFromQuery(remainder.slice("index.html?".length));
  }

  // path?query — check if path part is index.html
  if (remainder.includes("?")) {
    const [pathPart, query] = remainder.split("?", 2);
    if (pathPart === "index.html") {
      return extractFilenameFromQuery(query);
    }
  }

  if (!remainder) return null;
  return decodeURIComponent(remainder);
}

function extractFilenameFromQuery(query: string): string | null {
  if (!query) return null;

  if (query.includes("=")) {
    const params = new URLSearchParams(query);
    for (const key of ["file", "filename"]) {
      const value = params.get(key)?.trim();
      if (value) return decodeURIComponent(value);
    }
    return null;
  }

  const value = query.trim();
  return value ? decodeURIComponent(value) : null;
}

/**
 * Fetch from Jina reader with backoff retries on HTTP 451 and 5xx errors.
 */
async function fetchJinaWithRetry(
  fetchImpl: typeof fetch,
  readerUrl: string,
  jinaApiKey: string | undefined,
  logger: DefaultToolExecutorOptions["logger"],
): Promise<string> {
  for (let attempt = 0; attempt < jinaRetryConfig.delaysMs.length; attempt++) {
    const delay = jinaRetryConfig.delaysMs[attempt];
    if (delay > 0) {
      logger?.info(`Waiting ${delay / 1000}s before Jina retry ${attempt + 1}/${jinaRetryConfig.delaysMs.length}`);
      await new Promise((r) => setTimeout(r, delay));
    }

    const response = await fetchImpl(readerUrl, {
      headers: buildJinaHeaders(jinaApiKey),
    });

    if ((response.status === 451 || response.status >= 500) && attempt < jinaRetryConfig.delaysMs.length - 1) {
      continue;
    }

    const body = (await response.text()).trim();
    if (!response.ok) {
      throw new Error(`visit_webpage failed: Jina HTTP ${response.status}: ${body}`);
    }
    return body;
  }

  // Unreachable.
  throw new Error("Jina retry loop exhausted");
}

/**
 * Format text content: collapse excessive newlines, truncate, and wrap.
 */
function formatTextContent(url: string, body: string, maxLength: number): string {
  // Clean up multiple line breaks (3+ newlines → 2).
  let cleaned = body.replace(/\n{3,}/g, "\n\n");

  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength) + "\n\n..._Content truncated_...";
  }

  return `## Content from ${url}\n\n${cleaned}`;
}

function toolResultFromVisitWebpageOutput(url: string, output: VisitWebpageResult) {
  if (typeof output === "string") {
    return {
      content: [{ type: "text" as const, text: output }],
      details: { url, kind: "text" as const },
    };
  }

  return {
    content: [
      {
        type: "image" as const,
        data: output.data,
        mimeType: output.mimeType,
      },
    ],
    details: { url, kind: output.kind, mimeType: output.mimeType },
  };
}

function getFetch(options: DefaultToolExecutorOptions): typeof fetch {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("Global fetch API is unavailable.");
  }
  return fetchImpl;
}

function buildJinaHeaders(apiKey?: string, extras: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "muaddib/1.0",
    Accept: "text/plain",
    ...extras,
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function buildVisitHeaders(
  options: DefaultToolExecutorOptions,
  url: string,
  extras: Record<string, string> = {},
): Record<string, string> {
  const headers = {
    ...extras,
  };

  // Exact URL match from secrets.http_headers.
  const exactHeaders = resolveHttpHeadersExact(options.secrets, url);
  if (exactHeaders) {
    Object.assign(headers, exactHeaders);
    return headers;
  }

  // Prefix match from secrets.http_header_prefixes.
  const prefixHeaders = resolveHttpHeaderPrefixes(options.secrets);
  for (const [prefix, values] of Object.entries(prefixHeaders)) {
    if (!url.startsWith(prefix)) {
      continue;
    }

    Object.assign(headers, values);
    break;
  }

  return headers;
}

function resolveHttpHeadersExact(
  secrets: Record<string, unknown> | undefined,
  url: string,
): Record<string, string> | null {
  const raw = asObjectRecord(secrets?.http_headers);
  if (!raw) return null;

  const candidate = asObjectRecord(raw[url]);
  if (!candidate) return null;

  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(candidate)) {
    if (typeof value === "string" && value.trim()) {
      normalized[name] = value;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function resolveHttpHeaderPrefixes(
  secrets: Record<string, unknown> | undefined,
): Record<string, Record<string, string>> {
  const raw = asObjectRecord(secrets?.http_header_prefixes);
  if (!raw) {
    return {};
  }

  const resolved: Record<string, Record<string, string>> = {};
  for (const [prefix, headerObject] of Object.entries(raw)) {
    const headers = asObjectRecord(headerObject);
    if (!headers || !prefix) {
      continue;
    }

    const normalized: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "string" && value.trim()) {
        normalized[name] = value;
      }
    }

    if (Object.keys(normalized).length > 0) {
      resolved[prefix] = normalized;
    }
  }

  return resolved;
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function looksLikeImageUrl(url: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i.test(url);
}
