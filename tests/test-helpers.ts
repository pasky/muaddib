import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";

import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import type { RoomMessage } from "../src/rooms/message.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Create a ChatHistoryStore backed by a fresh temp directory. */
export function createTempHistoryStore(inferenceLimit = 20): ChatHistoryStore {
  const dir = mkdtempSync(join(tmpdir(), "muaddib-test-history-"));
  tempDirs.push(dir);
  return new ChatHistoryStore(dir, inferenceLimit);
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    resolve: resolve ?? (() => {}),
    reject: reject ?? (() => {}),
  };
}

export function waitForPersistedMessage(
  history: ChatHistoryStore,
  predicate: (message: RoomMessage) => boolean,
): Promise<void> {
  const persisted = createDeferred<void>();
  const originalAddMessage = history.addMessage.bind(history);

  vi.spyOn(history, "addMessage").mockImplementation(async (...args) => {
    const [message] = args;
    const result = await originalAddMessage(...(args as Parameters<typeof history.addMessage>));
    if (predicate(message as RoomMessage)) {
      persisted.resolve();
    }
    return result;
  });

  return persisted.promise;
}
