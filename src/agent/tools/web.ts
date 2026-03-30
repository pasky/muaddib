import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { Type } from "@sinclair/typebox";

import type { ToolContext, MuaddibTool } from "./types.js";
import { resolveLocalArtifactFilePath } from "./url-utils.js";
import {
  checkAndAutoApproveUrlInArc,
  getRedirectTarget,
  recordNetworkTrustEvent,
  recordNetworkTrustEvents,
  recordRedirectTrustEvent,
} from "../network-boundary.js";
import { resolveUrlAllowRegexes } from "../gondolin/env.js";
import { responseText } from "../message.js";
import { toConfiguredString } from "../../utils/index.js";

export interface VisitWebpageImageResult {
  kind: "image";
  data: string;
  mimeType: string;
}

export type VisitWebpageResult = string | VisitWebpageImageResult;

export type WebSearchExecutor = (query: string) => Promise<string>;
export type VisitWebpageExecutor = (url: string, query?: string) => Promise<VisitWebpageResult>;

const DEFAULT_WEB_CONTENT_LIMIT = 40_000;
const DEFAULT_IMAGE_LIMIT = 3_500_000;

/** Jina reader retry config. Mutable for test override. */
export const jinaRetryConfig = { delaysMs: [0, 30_000, 90_000] };

/**
 * Wrap a fetch call to surface the `.cause` from Node's opaque "fetch failed" TypeError.
 * Node 18+ fetch throws `TypeError("fetch failed")` for network-level errors
 * (DNS, connection refused, TLS, etc.) with the real reason buried in `.cause`.
 */
async function diagnosticFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err: unknown) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : "";
    const baseMsg = err instanceof Error ? err.message : String(err);
    const detail = causeMsg && !baseMsg.includes(causeMsg) ? `${baseMsg}: ${causeMsg}` : baseMsg;
    throw new Error(`${init?.method ?? "GET"} ${String(input)} failed: ${detail}`, { cause: err });
  }
}

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
      query: Type.Optional(Type.String({
        description: "Optional: describe what information to extract from the page. " +
          "When provided, the content transcript will focus on this query.",
      })),
    }),
    execute: async (_toolCallId, params) => {
      const output = await executors.visitWebpage(params.url, params.query);
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

const MAX_VISIT_REDIRECTS = 10;
const SEARCH_RESULT_URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/giu;

function extractSearchResultUrls(body: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const match of body.matchAll(SEARCH_RESULT_URL_RE)) {
    const candidate = sanitizeExtractedUrlCandidate(match[0]);
    try {
      const normalized = new URL(candidate).toString();
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      urls.push(normalized);
    } catch {
      // Ignore malformed URL-like substrings from search snippets.
    }
  }

  return urls;
}

function sanitizeExtractedUrlCandidate(value: string): string {
  return value.replace(/[),.;:]+$/u, "");
}

async function ensureVisitUrlTrusted(options: ToolContext, url: string): Promise<void> {
  const trust = await checkAndAutoApproveUrlInArc(options.arc, url, {
    autoApproveRegexes: resolveUrlAllowRegexes({
      config: options.toolsConfig?.gondolin ?? {},
      serverTag: options.serverTag,
      channelName: options.channelName,
    }),
  });
  if (trust.trusted) {
    return;
  }

  throw new Error(
    `Network access denied for ${trust.canonicalUrl}. Use web_search or request_network_access first.`,
  );
}

async function fetchVisitResponseWithRedirects(
  options: ToolContext,
  startUrl: string,
  init: Omit<RequestInit, "headers" | "redirect"> & { headers?: Record<string, string> },
): Promise<Response> {
  let currentUrl = startUrl;

  for (let redirectCount = 0; redirectCount <= MAX_VISIT_REDIRECTS; redirectCount += 1) {
    const response = await diagnosticFetch(currentUrl, {
      ...init,
      headers: buildVisitHeaders(options, currentUrl, init.headers),
      redirect: "manual",
    });

    const redirectTarget = getRedirectTarget(response, currentUrl);
    if (!redirectTarget) {
      return response;
    }

    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // ignore cancellation failures on redirect hops
      }
    }
    await recordRedirectTrustEvent(options.arc, {
      fromUrl: currentUrl,
      rawUrl: redirectTarget,
    });
    currentUrl = redirectTarget;
  }

  throw new Error(`visit_webpage failed: too many redirects for ${startUrl}`);
}

export function createDefaultWebSearchExecutor(
  options: ToolContext,
): WebSearchExecutor {


  return async (query: string): Promise<string> => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new Error("web_search.query must be non-empty.");
    }

    await searchRateLimiter.waitIfNeeded();

    const url = `https://s.jina.ai/?q=${encodeURIComponent(trimmedQuery)}`;
    const response = await diagnosticFetch(url, {
      headers: buildJinaHeaders(await options.authStorage.getApiKey("jina"), {
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

    const resultUrls = extractSearchResultUrls(body);
    await recordNetworkTrustEvents(
      options.arc,
      resultUrls.map((rawUrl) => ({ source: "web_search" as const, rawUrl })),
    );

    return `## Search Results\n\n${body}`;
  };
}

export function createDefaultVisitWebpageExecutor(
  options: ToolContext,
): VisitWebpageExecutor {

  const maxWebContentLength = options.toolsConfig?.jina?.maxWebContentLength ?? DEFAULT_WEB_CONTENT_LIMIT;
  const maxImageBytes = options.toolsConfig?.jina?.maxImageBytes ?? DEFAULT_IMAGE_LIMIT;

  return async (url: string, query?: string): Promise<VisitWebpageResult> => {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Invalid URL. Must start with http:// or https://");
    }

    // Check if this is a local artifact we can read directly from disk.
    const localResult = await tryReadLocalArtifact(options, url, maxWebContentLength, maxImageBytes);
    if (localResult !== null) {
      return localResult;
    }

    await ensureVisitUrlTrusted(options, url);
    await visitRateLimiter.waitIfNeeded();
    await recordNetworkTrustEvent(options.arc, { source: "visit_webpage", rawUrl: url });

    const baseRequestHeaders = {
      "User-Agent": "muaddib/1.0",
    };
    const initialRequestHeaders = buildVisitHeaders(options, url, baseRequestHeaders);

    let contentType = "";
    try {
      const headResponse = await fetchVisitResponseWithRedirects(options, url, {
        method: "HEAD",
        headers: baseRequestHeaders,
      });
      options.logger?.debug(`HEAD ${url} → ${headResponse.status} content-type=${headResponse.headers.get("content-type") ?? "(none)"}`);
      if (headResponse.ok) {
        contentType = (headResponse.headers.get("content-type") ?? "").toLowerCase();
      }
      if (headResponse.body) {
        try {
          await headResponse.body.cancel();
        } catch {
          // ignore cancellation failures for HEAD probes
        }
      }
    } catch (err) {
      // Recovery strategy: some sites disallow HEAD; continue with reader fallback.
      options.logger?.debug(`HEAD ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (contentType.startsWith("image/") && !contentType.includes("svg")) {
      const imageResponse = await fetchVisitResponseWithRedirects(options, url, {
        headers: baseRequestHeaders,
      });
      if (!imageResponse.ok) {
        throw new Error(`Failed to download image: HTTP ${imageResponse.status}`);
      }

      const rawImageMime =
        (imageResponse.headers.get("content-type") ?? "image/png").split(";")[0].trim();
      // Normalize non-standard "image/jpg" to the canonical "image/jpeg".
      const imageMimeType = rawImageMime === "image/jpg" ? "image/jpeg" : rawImageMime;
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

    const hasAuthHeaders = Object.entries(initialRequestHeaders).some(
      ([key, value]) => key.toLowerCase() !== "user-agent" && String(value).trim().length > 0,
    );

    if (hasAuthHeaders) {
      const response = await fetchVisitResponseWithRedirects(options, url, {
        headers: baseRequestHeaders,
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

      return transcribeWebContent(body, url, query, options, maxWebContentLength);
    }

    // Use Jina reader with retry/backoff.
    const readerUrl = `https://r.jina.ai/${url}`;
    const body = await fetchJinaWithRetry(readerUrl, await options.authStorage.getApiKey("jina"), options.logger);

    if (!body) {
      return `## Content from ${url}\n\n(Empty response)`;
    }

    return transcribeWebContent(body, url, query, options, maxWebContentLength);
  };
}

/**
 * Try to read a URL as a local artifact from disk. Returns null if the URL
 * does not match the configured artifacts URL.
 */
async function tryReadLocalArtifact(
  options: ToolContext,
  url: string,
  maxContentLength: number,
  maxImageBytes: number,
): Promise<VisitWebpageResult | null> {
  const artifactsPath = options.toolsConfig?.artifacts?.path;
  const artifactsUrl = options.toolsConfig?.artifacts?.url;
  const filePath = resolveLocalArtifactFilePath(url, artifactsUrl, artifactsPath);
  if (!filePath) return null;

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
 * Fetch from Jina reader with backoff retries on HTTP 451 and 5xx errors.
 */
async function fetchJinaWithRetry(
  readerUrl: string,
  jinaApiKey: string | undefined,
  logger: ToolContext["logger"],
): Promise<string> {
  for (let attempt = 0; attempt < jinaRetryConfig.delaysMs.length; attempt++) {
    const delay = jinaRetryConfig.delaysMs[attempt];
    if (delay > 0) {
      logger?.info(`Waiting ${delay / 1000}s before Jina retry ${attempt + 1}/${jinaRetryConfig.delaysMs.length}`);
      await new Promise((r) => setTimeout(r, delay));
    }

    const response = await diagnosticFetch(readerUrl, {
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

const WEB_TRANSCRIPT_SYSTEM_PROMPT =
  "You are a web content transcriber. Produce a clean, parsimonious transcript of the webpage content below.\n" +
  "Rules:\n" +
  "- Preserve all substantive content verbatim — exact wording, tone, and nuance\n" +
  "- Preserve all meaningful URLs/links inline in markdown format\n" +
  "- Remove: navigation menus, cookie banners/consent dialogs, login/signup forms, " +
  "site-wide footer links, sidebar widgets, ads, breadcrumbs, \"related products\", " +
  "shopping carts, social sharing buttons, and other non-content boilerplate\n" +
  "- Keep document structure (headings, lists, tables) intact\n" +
  "- Do NOT summarize or paraphrase — transcribe the actual content literally\n" +
  "- Do NOT add commentary or explanations\n" +
  "- Be thorough with the actual content but ruthless with boilerplate\n" +
  "- CRITICAL: If the page is an error, CAPTCHA, access-denied, or bot-detection wall, " +
  "output ONLY the literal error text you see. NEVER fabricate, guess, or reconstruct " +
  "what the article would say from your training data. You do not know the page content.";

/**
 * Post-process fetched web content through an LLM to strip boilerplate,
 * falling back to basic formatting when no model is configured.
 */
async function transcribeWebContent(
  body: string,
  url: string,
  query: string | undefined,
  options: ToolContext,
  maxLength: number,
): Promise<string> {
  const modelSpec = toConfiguredString(options.toolsConfig?.visitWebpage?.model);
  if (!modelSpec) {
    return formatTextContent(url, body, maxLength);
  }

  // Pre-clean and truncate before sending to LLM.
  let cleaned = body.replace(/\n{3,}/g, "\n\n");
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength) + "\n\n..._Content truncated_...";
  }

  const systemPrompt = query
    ? `${WEB_TRANSCRIPT_SYSTEM_PROMPT}\n\nFocus especially on information relevant to: ${query}`
    : WEB_TRANSCRIPT_SYSTEM_PROMPT;

  try {
    const response = await options.modelAdapter.completeSimple(
      modelSpec,
      {
        messages: [
          {
            role: "user",
            content: cleaned,
            timestamp: Date.now(),
          },
        ],
        systemPrompt,
      },
      {
        callType: "webTranscript",
        logger: options.logger,
        streamOptions: { reasoning: "low" },
      },
    );

    const text = responseText(response);
    if (text) {
      return `## Content from ${url}\n\n${text}`;
    }
  } catch (error) {
    options.logger?.error?.(
      "Web content transcription failed, returning raw content",
      error,
    );
  }

  return formatTextContent(url, body, maxLength);
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
  options: ToolContext,
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
