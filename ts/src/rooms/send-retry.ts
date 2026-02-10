const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;

interface SendRetryContext {
  platform: "discord" | "slack";
  destination: string;
}

export async function sendWithRateLimitRetry(
  send: () => Promise<void>,
  _context: SendRetryContext,
): Promise<void> {
  let attempt = 1;

  while (true) {
    try {
      await send();
      return;
    } catch (error) {
      const retryAfterMs = extractRetryAfterMs(error);
      const shouldRetry = retryAfterMs !== null && attempt < DEFAULT_MAX_ATTEMPTS;
      if (!shouldRetry) {
        throw error;
      }

      await sleep(retryAfterMs);
      attempt += 1;
    }
  }
}

function extractRetryAfterMs(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }

  const directMs = numberValue(error.retryAfterMs) ?? numberValue(error.retry_after_ms);
  if (directMs !== null) {
    return normalizeRetryAfterMs(directMs);
  }

  const secondsValue = numberValue(error.retry_after) ?? retryAfterHeaderSeconds(error.response);
  if (secondsValue !== null) {
    return normalizeRetryAfterMs(secondsValue * 1_000);
  }

  const code = String(error.code ?? "").toLowerCase();
  const status = numberValue(error.status) ?? numberValue(error.statusCode) ?? numberValue(error.code);
  if (status === 429 || code === "rate_limited" || code === "too_many_requests") {
    return DEFAULT_RETRY_AFTER_MS;
  }

  return null;
}

function retryAfterHeaderSeconds(response: unknown): number | null {
  if (!isRecord(response)) {
    return null;
  }

  const headers = response.headers;
  if (headers instanceof Headers) {
    return numberValue(headers.get("retry-after"));
  }

  if (!isRecord(headers)) {
    return null;
  }

  const value = headers["retry-after"] ?? headers["Retry-After"];
  if (typeof value === "string") {
    return numberValue(value);
  }

  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return numberValue(value[0]);
  }

  return null;
}

function normalizeRetryAfterMs(rawMs: number): number {
  if (!Number.isFinite(rawMs)) {
    return DEFAULT_RETRY_AFTER_MS;
  }

  const clamped = Math.max(0, Math.min(MAX_RETRY_AFTER_MS, rawMs));
  return Math.round(clamped);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
