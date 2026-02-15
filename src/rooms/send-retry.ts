import type { Logger } from "../app/logging.js";
import { isRecord, sleep, stringifyError } from "../utils/index.js";

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
  return value ?? DEFAULT_MAX_ATTEMPTS;
}

function extractRetryAfterMs(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }

  // Discord RateLimitError: .retryAfter in ms
  const directMs = numberValue(error.retryAfter);
  if (directMs !== null) {
    return normalizeRetryAfterMs(directMs);
  }

  // Slack: .retry_after in seconds
  const secondsValue = numberValue(error.retry_after);
  if (secondsValue !== null) {
    return normalizeRetryAfterMs(secondsValue * 1_000);
  }

  // Fallback: detect rate-limit by status/code without a timing hint
  const status = numberValue(error.status) ?? numberValue(error.statusCode);
  const code = typeof error.code === "string" ? error.code.toLowerCase() : "";
  if (status === 429 || code === "rate_limited") {
    return DEFAULT_RETRY_AFTER_MS;
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

/**
 * Wraps `sendWithRateLimitRetry`, capturing a typed result from the send callback.
 */
export async function sendWithRetryResult<T>(
  destination: string,
  platform: "discord" | "slack",
  onEvent: ((event: SendRetryEvent) => void) | undefined,
  send: () => Promise<T | void>,
): Promise<T | undefined> {
  let result: T | undefined;

  await sendWithRateLimitRetry(
    async () => {
      const next = await send();
      if (next !== undefined) {
        result = next;
      }
    },
    {
      platform,
      destination,
      onEvent,
    },
  );

  return result;
}

export function createSendRetryEventLogger(
  logger: Logger,
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

  if (isRecord(error)) {
    return error;
  }

  return { value: stringifyError(error) };
}
