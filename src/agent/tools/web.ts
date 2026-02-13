import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import type {
  BaselineToolExecutors,
  DefaultToolExecutorOptions,
  VisitWebpageResult,
} from "./types.js";

const DEFAULT_WEB_CONTENT_LIMIT = 40_000;
const DEFAULT_IMAGE_LIMIT = 3_500_000;

export function createWebSearchTool(executors: Pick<BaselineToolExecutors, "webSearch">): AgentTool<any> {
  return {
    name: "web_search",
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
  executors: Pick<BaselineToolExecutors, "visitWebpage">,
): AgentTool<any> {
  return {
    name: "visit_webpage",
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

export function createDefaultWebSearchExecutor(
  options: DefaultToolExecutorOptions,
): BaselineToolExecutors["webSearch"] {
  const fetchImpl = getFetch(options);

  return async (query: string): Promise<string> => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new Error("web_search.query must be non-empty.");
    }

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
): BaselineToolExecutors["visitWebpage"] {
  const fetchImpl = getFetch(options);
  const maxWebContentLength = options.maxWebContentLength ?? DEFAULT_WEB_CONTENT_LIMIT;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_IMAGE_LIMIT;

  return async (url: string): Promise<VisitWebpageResult> => {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Invalid URL. Must start with http:// or https://");
    }

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

      const body = (await response.text()).trim();
      if (!response.ok) {
        throw new Error(`visit_webpage failed: HTTP ${response.status}: ${body}`);
      }

      if (!body) {
        return `## Content from ${url}\n\n(Empty response)`;
      }

      const limitedBody =
        body.length > maxWebContentLength
          ? `${body.slice(0, maxWebContentLength)}\n\n..._Content truncated_...`
          : body;

      return `## Content from ${url}\n\n${limitedBody}`;
    }

    const readerUrl = `https://r.jina.ai/${url}`;
    const response = await fetchImpl(readerUrl, {
      headers: buildJinaHeaders(options.jinaApiKey),
    });

    const body = (await response.text()).trim();
    if (!response.ok) {
      throw new Error(`visit_webpage failed: Jina HTTP ${response.status}: ${body}`);
    }

    if (!body) {
      return `## Content from ${url}\n\n(Empty response)`;
    }

    const limitedBody =
      body.length > maxWebContentLength
        ? `${body.slice(0, maxWebContentLength)}\n\n..._Content truncated_...`
        : body;

    return `## Content from ${url}\n\n${limitedBody}`;
  };
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

  const prefixHeaders = resolveHttpHeaderPrefixes(options.secrets);
  for (const [prefix, values] of Object.entries(prefixHeaders)) {
    if (!url.startsWith(prefix)) {
      continue;
    }

    Object.assign(headers, values);
  }

  return headers;
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
