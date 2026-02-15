/**
 * Shared utility functions extracted from duplicated copies across the codebase.
 */

/** Delay execution for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Escape special characters for use in a RegExp pattern. */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validate that `value` is a non-empty string, throwing with `message` otherwise.
 * Returns the (original, untrimmed) string on success.
 */
export function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}

/**
 * Coerce an unknown config value to a trimmed non-empty string, or `undefined`.
 * Useful for optional config fields that may be empty strings or non-strings.
 */
export function toConfiguredString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Extract a human-readable message from an unknown error value. */
export function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
