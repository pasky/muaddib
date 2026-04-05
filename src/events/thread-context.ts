/**
 * AsyncLocalStorage-based thread context for event auto-population.
 *
 * When an agent session writes an event file, the ArcEventsWatcher can
 * read the current threadId from this context and auto-populate it,
 * so the agent doesn't need to manually include threadId in the JSON.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const threadIdStorage = new AsyncLocalStorage<string | undefined>();

/**
 * Run `fn` with the given threadId available to `getCurrentThreadId()`.
 * Works with both sync and async functions (AsyncLocalStorage propagates
 * through await chains).
 */
export function runWithThreadId<T>(threadId: string | undefined, fn: () => T): T {
  return threadIdStorage.run(threadId, fn);
}

/** Read the threadId from the current async context, if any. */
export function getCurrentThreadId(): string | undefined {
  return threadIdStorage.getStore();
}
