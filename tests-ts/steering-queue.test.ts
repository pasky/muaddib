import { describe, it, expect } from "vitest";
import { SteeringQueue, QueuedInboundMessage } from "../src/rooms/command/steering-queue.js";
import type { RoomMessage } from "../src/rooms/message.js";

function makeMessage(content: string, overrides?: Partial<RoomMessage>): RoomMessage {
  return {
    serverTag: "irc.test",
    channelName: "#test",
    nick: "alice",
    mynick: "bot",
    content,
    threadId: undefined,
    secrets: {},
    ...overrides,
  };
}

describe("SteeringQueue", () => {
  // ── Key computation ──

  it("computes key from arc + nick for non-threaded messages", () => {
    const key = SteeringQueue.keyForMessage(makeMessage("hello"));
    expect(key).toEqual(["irc.test##test", "alice", null]);
  });

  it("computes key from arc + threadId for threaded messages (nick is wildcard)", () => {
    const key = SteeringQueue.keyForMessage(makeMessage("hello", { threadId: "t1" }));
    expect(key).toEqual(["irc.test##test", "*", "t1"]);
  });

  // ── enqueueCommandOrStartRunner ──

  it("first command becomes runner", () => {
    const q = new SteeringQueue();
    const msg = makeMessage("!s hello");
    const { isRunner, item } = q.enqueueCommandOrStartRunner(msg, 1);
    expect(isRunner).toBe(true);
    expect(item.kind).toBe("command");
  });

  it("second command for same key is queued (not runner)", () => {
    const q = new SteeringQueue();
    const msg1 = makeMessage("!s first");
    const msg2 = makeMessage("!s second");
    const r1 = q.enqueueCommandOrStartRunner(msg1, 1);
    const r2 = q.enqueueCommandOrStartRunner(msg2, 2);
    expect(r1.isRunner).toBe(true);
    expect(r2.isRunner).toBe(false);
  });

  it("commands from different keys both become runners", () => {
    const q = new SteeringQueue();
    const msg1 = makeMessage("!s first", { nick: "alice" });
    const msg2 = makeMessage("!s second", { nick: "bob" });
    const r1 = q.enqueueCommandOrStartRunner(msg1, 1);
    const r2 = q.enqueueCommandOrStartRunner(msg2, 2);
    expect(r1.isRunner).toBe(true);
    expect(r2.isRunner).toBe(true);
  });

  // ── enqueuePassive ──

  it("passive into existing session is queued", () => {
    const q = new SteeringQueue();
    q.enqueueCommandOrStartRunner(makeMessage("!s cmd"), 1);
    const { queued } = q.enqueuePassive(makeMessage("passive"));
    expect(queued).toBe(true);
  });

  it("passive with no session and no proactive is not queued", () => {
    const q = new SteeringQueue();
    const { queued, isProactiveRunner } = q.enqueuePassive(makeMessage("passive"));
    expect(queued).toBe(false);
    expect(isProactiveRunner).toBe(false);
  });

  it("passive with no session and startProactive starts proactive runner", () => {
    const q = new SteeringQueue();
    const { queued, isProactiveRunner } = q.enqueuePassive(makeMessage("passive"), undefined, true);
    expect(queued).toBe(false);
    expect(isProactiveRunner).toBe(true);
  });

  // ── drainSteeringContextMessages ──

  it("drains queued messages as steering context and finishes them", async () => {
    const q = new SteeringQueue();
    const msg1 = makeMessage("!s first");
    q.enqueueCommandOrStartRunner(msg1, 1);

    const msg2 = makeMessage("passive1");
    const { item: item2 } = q.enqueuePassive(msg2);
    const msg3 = makeMessage("!s second");
    const { item: item3 } = q.enqueueCommandOrStartRunner(msg3, 2);

    const drained = q.drainSteeringContextMessages(SteeringQueue.keyForMessage(msg1));
    expect(drained).toHaveLength(2);
    expect(drained[0].content).toContain("passive1");
    expect(drained[1].content).toContain("second");

    // Items should be finished
    await expect(item2.completion).resolves.toBeUndefined();
    await expect(item3.completion).resolves.toBeUndefined();
  });

  it("returns empty array when no items queued", () => {
    const q = new SteeringQueue();
    const key = SteeringQueue.keyForMessage(makeMessage("x"));
    expect(q.drainSteeringContextMessages(key)).toEqual([]);
  });

  // ── createContextDrainer ──

  it("createContextDrainer returns callback that drains with role/content", () => {
    const q = new SteeringQueue();
    const msg = makeMessage("!s cmd");
    q.enqueueCommandOrStartRunner(msg, 1);
    q.enqueuePassive(makeMessage("follow-up"));

    const drainer = q.createContextDrainer(SteeringQueue.keyForMessage(msg));
    const result = drainer();
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toContain("follow-up");

    // Second call returns empty (already drained)
    expect(drainer()).toEqual([]);
  });

  // ── releaseSession ──

  it("releaseSession finishes passives and fails commands", async () => {
    const q = new SteeringQueue();
    const msg = makeMessage("!s first");
    const { steeringKey } = q.enqueueCommandOrStartRunner(msg, 1);

    const { item: passive } = q.enqueuePassive(makeMessage("p1"));
    const { item: cmd } = q.enqueueCommandOrStartRunner(makeMessage("!s second"), 2);
    const { item: passive2 } = q.enqueuePassive(makeMessage("p2"));

    q.releaseSession(steeringKey);

    // Passives are finished
    await expect(passive.completion).resolves.toBeUndefined();
    await expect(passive2.completion).resolves.toBeUndefined();

    // Command is failed (so caller retries)
    await expect(cmd.completion).rejects.toThrow("retry");
  });

  it("releaseSession allows next command to become runner", async () => {
    const q = new SteeringQueue();
    const msg = makeMessage("!s first");
    const { steeringKey } = q.enqueueCommandOrStartRunner(msg, 1);
    q.releaseSession(steeringKey);

    // Session is gone, next command becomes runner
    const { isRunner } = q.enqueueCommandOrStartRunner(makeMessage("!s next"), 2);
    expect(isRunner).toBe(true);
  });

  it("releaseSession is no-op for nonexistent session", () => {
    const q = new SteeringQueue();
    const key = SteeringQueue.keyForMessage(makeMessage("x"));
    // Should not throw
    q.releaseSession(key);
  });

  // ── abortSession ──

  it("abortSession fails all queued items with the error", async () => {
    const q = new SteeringQueue();
    const msg = makeMessage("!s first");
    const { steeringKey } = q.enqueueCommandOrStartRunner(msg, 1);

    const { item: passive } = q.enqueuePassive(makeMessage("p1"));
    const { item: cmd } = q.enqueueCommandOrStartRunner(makeMessage("!s second"), 2);

    const error = new Error("boom");
    q.abortSession(steeringKey, error);

    await expect(passive.completion).rejects.toThrow("boom");
    await expect(cmd.completion).rejects.toThrow("boom");
  });

  // ── waitForNewItem ──

  it("waitForNewItem resolves immediately if items already queued", async () => {
    const q = new SteeringQueue();
    const msg = makeMessage("!s cmd");
    const { steeringKey } = q.enqueueCommandOrStartRunner(msg, 1);
    q.enqueuePassive(makeMessage("queued"));

    const result = await q.waitForNewItem(steeringKey, 5000);
    expect(result).toBe("woken");
  });

  it("waitForNewItem times out when no items arrive", async () => {
    const q = new SteeringQueue();
    const msg = makeMessage("!s cmd");
    const { steeringKey } = q.enqueueCommandOrStartRunner(msg, 1);

    const result = await q.waitForNewItem(steeringKey, 10);
    expect(result).toBe("timeout");
  });

  it("waitForNewItem wakes when item is enqueued", async () => {
    const q = new SteeringQueue();
    const msg = makeMessage("!s cmd");
    const { steeringKey } = q.enqueueCommandOrStartRunner(msg, 1);

    const waitPromise = q.waitForNewItem(steeringKey, 5000);
    q.enqueuePassive(makeMessage("wake-up"));

    const result = await waitPromise;
    expect(result).toBe("woken");
  });

  it("waitForNewItem returns timeout for nonexistent session", async () => {
    const q = new SteeringQueue();
    const key = SteeringQueue.keyForMessage(makeMessage("x"));
    const result = await q.waitForNewItem(key, 10);
    expect(result).toBe("timeout");
  });

  // ── hasQueuedCommands ──

  it("hasQueuedCommands returns false with no session", () => {
    const q = new SteeringQueue();
    const key = SteeringQueue.keyForMessage(makeMessage("x"));
    expect(q.hasQueuedCommands(key)).toBe(false);
  });

  it("hasQueuedCommands returns false with only passives", () => {
    const q = new SteeringQueue();
    const msg = makeMessage("!s cmd");
    q.enqueueCommandOrStartRunner(msg, 1);
    q.enqueuePassive(makeMessage("p1"));
    expect(q.hasQueuedCommands(SteeringQueue.keyForMessage(msg))).toBe(false);
  });

  it("hasQueuedCommands returns true with a queued command", () => {
    const q = new SteeringQueue();
    const msg = makeMessage("!s cmd");
    q.enqueueCommandOrStartRunner(msg, 1);
    q.enqueueCommandOrStartRunner(makeMessage("!s second"), 2);
    expect(q.hasQueuedCommands(SteeringQueue.keyForMessage(msg))).toBe(true);
  });

  // ── QueuedInboundMessage ──

  it("finish resolves completion promise", async () => {
    const item = new QueuedInboundMessage("command", makeMessage("x"), 1);
    item.finish();
    await expect(item.completion).resolves.toBeUndefined();
  });

  it("fail rejects completion promise", async () => {
    const item = new QueuedInboundMessage("command", makeMessage("x"), 1);
    item.fail(new Error("test"));
    await expect(item.completion).rejects.toThrow("test");
  });

  it("double finish is idempotent", async () => {
    const item = new QueuedInboundMessage("command", makeMessage("x"), 1);
    item.finish();
    item.finish(); // should not throw
    await expect(item.completion).resolves.toBeUndefined();
  });

  it("fail after finish is ignored", async () => {
    const item = new QueuedInboundMessage("command", makeMessage("x"), 1);
    item.finish();
    item.fail(new Error("late"));
    await expect(item.completion).resolves.toBeUndefined();
  });

  // ── steeringContextMessage ──

  it("formats steering context message with nick prefix", () => {
    const msg = SteeringQueue.steeringContextMessage(makeMessage("hello world"));
    expect(msg).toEqual({ role: "user", content: "<alice> hello world" });
  });
});
