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

/** Type guard: is the value a non-array plain object? */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cast to Record if it's a non-array plain object, otherwise null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Normalize a display name to an underscore-separated identifier. */
export function normalizeName(name: string): string {
  return name.trim().split(/\s+/u).join("_");
}

/** Current wall-clock time in fractional seconds (for debounce comparisons). */
export function nowMonotonicSeconds(): number {
  return Date.now() / 1_000;
}

/**
 * Extract the auto-increment row ID from an INSERT result, throwing if absent.
 * Prevents silent use of 0 as a row ID when lastID is unexpectedly nullish.
 */
export function requireLastID(result: { lastID?: number | bigint }): number {
  const id = result.lastID;
  if (id == null) {
    throw new Error("INSERT did not return a lastID");
  }
  return Number(id);
}

/**
 * Add a column to a table if it doesn't already exist.
 * Uses PRAGMA table_info to check, then ALTER TABLE to add.
 */
export async function migrateAddColumn(
  db: { all: <T>(sql: string) => Promise<T>; exec: (sql: string) => Promise<void> },
  table: string,
  column: string,
  type: string,
): Promise<boolean> {
  const columns = await db.all<Array<{ name: string }>>(`PRAGMA table_info(${table})`);
  if (columns.some((c) => c.name === column)) {
    return false;
  }
  await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return true;
}

/** Combine message content with an attachment block, handling empty cases. */
export function appendAttachmentBlock(content: string, attachmentBlock: string): string {
  if (!attachmentBlock) {
    return content.trim();
  }

  if (!content.trim()) {
    return attachmentBlock;
  }

  return `${content.trim()}\n\n${attachmentBlock}`;
}
