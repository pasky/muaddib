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

export interface JsonSerializationOptions {
  preserveContentText?: boolean;
  preserveContentThinking?: boolean;
}

function shouldPreserveLeafString(
  parent: unknown,
  key: string | number | undefined,
  options: JsonSerializationOptions,
): boolean {
  if (!parent || typeof parent !== "object" || typeof key !== "string") {
    return false;
  }

  const parentRecord = parent as Record<string, unknown>;
  if (options.preserveContentText && key === "text" && parentRecord.type === "text") {
    return true;
  }

  if (options.preserveContentThinking && key === "thinking" && parentRecord.type === "thinking") {
    return true;
  }

  return false;
}

function truncateLeafStrings(
  value: unknown,
  options: JsonSerializationOptions,
  parent?: unknown,
  key?: string | number,
): unknown {
  if (typeof value === "string") {
    if (shouldPreserveLeafString(parent, key, options) || value.length <= LEAF_STRING_MAX) {
      return value;
    }

    const half = Math.floor((LEAF_STRING_MAX - 3) / 2);
    return `${value.slice(0, half)}...${value.slice(-half)}`;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => truncateLeafStrings(entry, options, value, index));
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = truncateLeafStrings(childValue, options, value, childKey);
    }
    return out;
  }

  return value;
}

export function safeJson(value: unknown, maxChars: number, options: JsonSerializationOptions = {}): string {
  try {
    return truncateForDebug(JSON.stringify(truncateLeafStrings(value, options), null, 2), maxChars);
  } catch {
    return "[unserializable payload]";
  }
}

export function compactJson(value: unknown, maxChars: number, options: JsonSerializationOptions = {}): string {
  try {
    return truncateForDebug(JSON.stringify(truncateLeafStrings(value, options)), maxChars);
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
