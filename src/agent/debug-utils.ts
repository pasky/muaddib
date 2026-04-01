const BINARY_DATA_PREVIEW_LENGTH = 512;

/**
 * Recursively replace inline binary blobs (e.g. base64 image data) with a
 * short placeholder that includes a preview of the first bytes.
 * Keeps the rest of the structure intact so debug logs remain informative.
 */
export function stripBinaryContent(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(stripBinaryContent);
  }

  const record = value as Record<string, unknown>;

  // Content block with type "image" carrying base64 data
  if (record.type === "image" && typeof record.data === "string") {
    const data = record.data;
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : "unknown";
    const preview = data.slice(0, BINARY_DATA_PREVIEW_LENGTH);
    const suffix = data.length > BINARY_DATA_PREVIEW_LENGTH
      ? `...[${data.length} chars total]`
      : "";
    return {
      type: "image",
      data: `[binary image data, ${mimeType}] ${preview}${suffix}`,
      mimeType: record.mimeType,
    };
  }

  // Content block with type "image_url" carrying a base64 data: URL (OpenAI format)
  if (record.type === "image_url" && record.image_url && typeof record.image_url === "object") {
    const inner = record.image_url as Record<string, unknown>;
    if (typeof inner.url === "string" && inner.url.startsWith("data:")) {
      const url = inner.url;
      const preview = url.slice(0, BINARY_DATA_PREVIEW_LENGTH);
      const suffix = url.length > BINARY_DATA_PREVIEW_LENGTH
        ? `...[${url.length} chars total]`
        : "";
      return {
        type: "image_url",
        image_url: { url: `[base64 data url] ${preview}${suffix}` },
      };
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    out[key] = stripBinaryContent(val);
  }
  return out;
}

export function safeJson(value: unknown, maxChars: number): string {
  try {
    return truncateForDebug(JSON.stringify(stripBinaryContent(value), null, 2), maxChars);
  } catch {
    return "[unserializable payload]";
  }
}

export function compactJson(value: unknown, maxChars: number): string {
  try {
    return truncateForDebug(JSON.stringify(stripBinaryContent(value)), maxChars);
  } catch {
    return "[unserializable payload]";
  }
}

export function truncateForDebug(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 24))}...[truncated ${value.length - maxChars} chars]`;
}
