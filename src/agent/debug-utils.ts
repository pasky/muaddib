import type { Usage } from "@mariozechner/pi-ai";

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

const LEAF_STRING_MAX = 2048;

function truncateLeafStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= LEAF_STRING_MAX) return value;
    const half = Math.floor((LEAF_STRING_MAX - 3) / 2);
    return `${value.slice(0, half)}...${value.slice(-half)}`;
  }
  if (Array.isArray(value)) return value.map(truncateLeafStrings);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = truncateLeafStrings(v);
    }
    return out;
  }
  return value;
}

export function safeJson(value: unknown, maxChars: number): string {
  try {
    return truncateForDebug(JSON.stringify(truncateLeafStrings(value), null, 2), maxChars);
  } catch {
    return "[unserializable payload]";
  }
}

export function compactJson(value: unknown, maxChars: number): string {
  try {
    return truncateForDebug(JSON.stringify(truncateLeafStrings(value)), maxChars);
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
