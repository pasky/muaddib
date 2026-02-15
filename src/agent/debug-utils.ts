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

export function safeJson(value: unknown, maxChars: number): string {
  try {
    return truncateForDebug(JSON.stringify(value, null, 2), maxChars);
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
