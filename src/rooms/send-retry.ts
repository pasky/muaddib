const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;

export interface SendRetryEvent {
  type: "retry" | "failed";
  retryable: boolean;
  platform: "discord" | "slack";
  destination: string;
  attempt: number;
  maxAttempts: number;
  retryAfterMs: number | null;
  error: unknown;
}

interface SendRetryContext {
  platform: "discord" | "slack";
  destination: string;
  maxAttempts?: number;
  onEvent?: (event: SendRetryEvent) => void;
}

export async function sendWithRateLimitRetry(
  send: () => Promise<void>,
  context: SendRetryContext,
): Promise<void> {
  let attempt = 1;
  const maxAttempts = normalizeMaxAttempts(context.maxAttempts);

  while (true) {
    try {
      await send();
      return;
    } catch (error) {
      const retryAfterMs = extractRetryAfterMs(error);
      const retryable = retryAfterMs !== null;

      if (retryable && attempt < maxAttempts) {
        context.onEvent?.({
          type: "retry",
          retryable,
          platform: context.platform,
          destination: context.destination,
          attempt,
          maxAttempts,
          retryAfterMs,
          error,
        });

        await sleep(retryAfterMs);
        attempt += 1;
        continue;
      }

      context.onEvent?.({
        type: "failed",
        retryable,
        platform: context.platform,
        destination: context.destination,
        attempt,
        maxAttempts,
        retryAfterMs,
        error,
      });
      throw error;
    }
  }
}

function normalizeMaxAttempts(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.floor(value);
  }
  return DEFAULT_MAX_ATTEMPTS;
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

export interface SendRetryLogger {
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
}

export function createSendRetryEventLogger(
  logger: SendRetryLogger,
): (event: SendRetryEvent) => void {
  return (event: SendRetryEvent): void => {
    const payload = {
      event: "send_retry",
      type: event.type,
      retryable: event.retryable,
      platform: event.platform,
      destination: event.destination,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      retryAfterMs: event.retryAfterMs,
      error: summarizeRetryError(event.error),
    };

    const serialized = JSON.stringify(payload);

    if (event.type === "retry") {
      logger.warn("[muaddib][send-retry]", serialized);
    } else {
      logger.error("[muaddib][send-retry]", serialized);
    }

    logger.info("[muaddib][metric]", serialized);
  };
}

function summarizeRetryError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const extra = error as Error & {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };

    return {
      name: error.name,
      message: error.message,
      code: extra.code,
      status: extra.status,
      statusCode: extra.statusCode,
    };
  }

  if (typeof error === "object" && error !== null) {
    return error as Record<string, unknown>;
  }

  return {
    value: String(error),
  };
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
