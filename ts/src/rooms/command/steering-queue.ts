import { roomArc, type RoomMessage } from "../message.js";

export type SteeringKey = readonly [arc: string, nick: string, threadId: string | null];

export interface SteeringContextMessage {
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
    return { isRunner: false, steeringKey, item };
  }

  enqueuePassiveIfSessionExists(
    message: RoomMessage,
    sendResponse?: (text: string) => Promise<void>,
  ): QueuedInboundMessage | null {
    const steeringKey = SteeringQueue.keyForMessage(message);
    const session = this.sessions.get(this.steeringKeyId(steeringKey));

    if (!session) {
      return null;
    }

    const queuedItem = new QueuedInboundMessage("passive", message, null, sendResponse);
    session.queue.push(queuedItem);
    return queuedItem;
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

  private steeringKeyId(key: SteeringKey): string {
    return `${key[0]}\u0000${key[1]}\u0000${key[2] ?? ""}`;
  }
}
