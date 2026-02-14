import type { ChatRole } from "../../history/chat-history-store.js";
import { roomArc, type RoomMessage } from "../message.js";

export type SteeringKey = readonly [arc: string, nick: string, threadId: string | null];

interface SteeringContextMessage {
  role: "user";
  content: string;
}

export class QueuedInboundMessage {
  readonly completion: Promise<void>;
  result: unknown = null;

  private settled = false;
  private readonly resolveCompletion: () => void;
  private readonly rejectCompletion: (reason?: unknown) => void;

  constructor(
    readonly kind: "command" | "passive",
    readonly message: RoomMessage,
    readonly triggerMessageId: number | null,
    readonly sendResponse?: (text: string) => Promise<void>,
  ) {
    let resolve: (() => void) | undefined;
    let reject: ((reason?: unknown) => void) | undefined;

    this.completion = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });

    this.resolveCompletion = resolve ?? (() => {});
    this.rejectCompletion = reject ?? (() => {});
  }

  finish(): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolveCompletion();
  }

  fail(error: unknown): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.rejectCompletion(error);
  }
}

interface SteeringSession {
  queue: QueuedInboundMessage[];
  /** Resolve function to wake the runner when a new item is enqueued. */
  wakeRunner?: () => void;
}

export class SteeringQueue {
  private readonly sessions = new Map<string, SteeringSession>();

  static keyForMessage(message: RoomMessage): SteeringKey {
    if (message.threadId) {
      return [roomArc(message), "*", message.threadId];
    }

    return [roomArc(message), message.nick.toLowerCase(), null];
  }

  static steeringContextMessage(message: RoomMessage): SteeringContextMessage {
    return {
      role: "user",
      content: `<${message.nick}> ${message.content}`,
    };
  }

  finishItem(item: QueuedInboundMessage): void {
    item.finish();
  }

  failItem(item: QueuedInboundMessage, error: unknown): void {
    item.fail(error);
  }

  enqueueCommandOrStartRunner(
    message: RoomMessage,
    triggerMessageId: number,
    sendResponse?: (text: string) => Promise<void>,
  ): {
    isRunner: boolean;
    steeringKey: SteeringKey;
    item: QueuedInboundMessage;
  } {
    const item = new QueuedInboundMessage("command", message, triggerMessageId, sendResponse);
    const steeringKey = SteeringQueue.keyForMessage(message);
    const keyId = this.steeringKeyId(steeringKey);

    const session = this.sessions.get(keyId);
    if (!session) {
      this.sessions.set(keyId, { queue: [] });
      return { isRunner: true, steeringKey, item };
    }

    session.queue.push(item);
    this.wakeSession(session);
    return { isRunner: false, steeringKey, item };
  }

  /**
   * Enqueue a passive message into an existing session, or start a new
   * proactive runner session if none exists and `startProactive` is true.
   *
   * Returns `{ queued, isProactiveRunner, steeringKey, item }`:
   * - `queued=true, isProactiveRunner=false` — item enqueued into existing session
   * - `queued=false, isProactiveRunner=true` — new proactive session started, caller is runner
   * - `queued=false, isProactiveRunner=false` — no session exists and proactive not requested
   */
  enqueuePassive(
    message: RoomMessage,
    sendResponse?: (text: string) => Promise<void>,
    startProactive?: boolean,
  ): {
    queued: boolean;
    isProactiveRunner: boolean;
    steeringKey: SteeringKey;
    item: QueuedInboundMessage;
  } {
    const steeringKey = SteeringQueue.keyForMessage(message);
    const keyId = this.steeringKeyId(steeringKey);
    const item = new QueuedInboundMessage("passive", message, null, sendResponse);

    const session = this.sessions.get(keyId);
    if (session) {
      session.queue.push(item);
      this.wakeSession(session);
      return { queued: true, isProactiveRunner: false, steeringKey, item };
    }

    if (startProactive) {
      this.sessions.set(keyId, { queue: [] });
      return { queued: false, isProactiveRunner: true, steeringKey, item };
    }

    return { queued: false, isProactiveRunner: false, steeringKey, item };
  }

  drainSteeringContextMessages(key: SteeringKey): SteeringContextMessage[] {
    const session = this.sessions.get(this.steeringKeyId(key));
    if (!session || session.queue.length === 0) {
      return [];
    }

    const drained = [...session.queue];
    session.queue = [];

    for (const item of drained) {
      this.finishItem(item);
    }

    return drained.map((item) => SteeringQueue.steeringContextMessage(item.message));
  }

  takeNextWorkCompacted(key: SteeringKey): {
    dropped: QueuedInboundMessage[];
    nextItem: QueuedInboundMessage | null;
  } {
    const keyId = this.steeringKeyId(key);
    const session = this.sessions.get(keyId);

    if (!session) {
      return { dropped: [], nextItem: null };
    }

    if (session.queue.length === 0) {
      this.sessions.delete(keyId);
      return { dropped: [], nextItem: null };
    }

    const firstCommandIndex = session.queue.findIndex((item) => item.kind === "command");

    if (firstCommandIndex >= 0) {
      const dropped = session.queue.slice(0, firstCommandIndex);
      const nextItem = session.queue[firstCommandIndex] ?? null;
      session.queue = session.queue.slice(firstCommandIndex + 1);
      return { dropped, nextItem };
    }

    const dropped = session.queue.slice(0, -1);
    const nextItem = session.queue[session.queue.length - 1] ?? null;
    session.queue = [];
    return { dropped, nextItem };
  }

  /**
   * Wait until a new item is enqueued into the session, or until `timeoutMs`
   * elapses.  Returns `"woken"` if a new item arrived, `"timeout"` otherwise.
   */
  waitForNewItem(key: SteeringKey, timeoutMs: number): Promise<"woken" | "timeout"> {
    const keyId = this.steeringKeyId(key);
    const session = this.sessions.get(keyId);
    if (!session) {
      return Promise.resolve("timeout");
    }

    // If items are already queued, return immediately.
    if (session.queue.length > 0) {
      return Promise.resolve("woken");
    }

    return new Promise<"woken" | "timeout">((resolve) => {
      const timer = setTimeout(() => {
        // Clear wake so a later enqueue doesn't resolve a stale promise.
        if (session.wakeRunner === wake) {
          session.wakeRunner = undefined;
        }
        resolve("timeout");
      }, timeoutMs);

      const wake = () => {
        clearTimeout(timer);
        if (session.wakeRunner === wake) {
          session.wakeRunner = undefined;
        }
        resolve("woken");
      };

      session.wakeRunner = wake;
    });
  }

  /**
   * Check whether the session has any queued command items.
   */
  hasQueuedCommands(key: SteeringKey): boolean {
    const session = this.sessions.get(this.steeringKeyId(key));
    if (!session) {
      return false;
    }
    return session.queue.some((item) => item.kind === "command");
  }

  /**
   * Create a steering context drainer for the given session key.
   * The returned callback drains all queued messages as context,
   * finishing those items and returning their content.
   */
  createContextDrainer(key: SteeringKey): () => Array<{ role: ChatRole; content: string }> {
    return () =>
      this.drainSteeringContextMessages(key).map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));
  }

  /**
   * Drain remaining queued items from a session, compacting passives.
   * For each work item, calls `processItem` with the item and a
   * steering context drainer, then finishes it.
   * Dropped (compacted) passive items are finished with `result = null`.
   * Closes the session when the queue is empty.
   */
  async drainSession(
    key: SteeringKey,
    processItem: (
      item: QueuedInboundMessage,
      contextDrainer: () => Array<{ role: ChatRole; content: string }>,
    ) => Promise<void>,
  ): Promise<void> {
    const contextDrainer = this.createContextDrainer(key);
    while (true) {
      const { dropped, nextItem } = this.takeNextWorkCompacted(key);
      for (const droppedItem of dropped) {
        droppedItem.result = null;
        this.finishItem(droppedItem);
      }

      if (!nextItem) {
        return;
      }

      await processItem(nextItem, contextDrainer);
      this.finishItem(nextItem);
    }
  }

  abortSession(key: SteeringKey, error: unknown): QueuedInboundMessage[] {
    const keyId = this.steeringKeyId(key);
    const session = this.sessions.get(keyId);
    if (!session) {
      return [];
    }

    this.sessions.delete(keyId);
    const remaining = [...session.queue];

    for (const item of remaining) {
      this.failItem(item, error);
    }

    return remaining;
  }

  /**
   * Close a session without error, finishing all remaining queued items.
   */
  closeSession(key: SteeringKey): void {
    const keyId = this.steeringKeyId(key);
    const session = this.sessions.get(keyId);
    if (!session) {
      return;
    }

    this.sessions.delete(keyId);
    for (const item of session.queue) {
      this.finishItem(item);
    }
  }

  private wakeSession(session: SteeringSession): void {
    if (session.wakeRunner) {
      session.wakeRunner();
    }
  }

  private steeringKeyId(key: SteeringKey): string {
    return `${key[0]}\u0000${key[1]}\u0000${key[2] ?? ""}`;
  }
}
