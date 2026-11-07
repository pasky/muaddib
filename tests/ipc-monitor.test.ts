import { describe, expect, it, vi } from "vitest";

import { AuthStore } from "../src/auth/auth-store.js";
import {
  IpcRoomMonitor,
  parseIpcInbound,
  type IpcChannel,
  type IpcOutbound,
} from "../src/rooms/ipc/monitor.js";
import type { RoomMessage } from "../src/rooms/message.js";
import { baseCommandConfig } from "./e2e/helpers.js";
import { createTempHistoryStore } from "./test-helpers.js";
import { createTestRuntime } from "./test-runtime.js";

/** An IPC channel whose two ends are this test. */
class FakeChannel implements IpcChannel {
  readonly sent: IpcOutbound[] = [];
  private handler: ((message: unknown) => void) | undefined;
  private disconnect: (() => void) | undefined;

  send(message: IpcOutbound): void {
    this.sent.push(message);
  }
  onMessage(handler: (message: unknown) => void): void {
    this.handler = handler;
  }
  onDisconnect(handler: () => void): void {
    this.disconnect = handler;
  }
  deliver(message: unknown): void {
    this.handler?.(message);
  }
  hangUp(): void {
    this.disconnect?.();
  }
}

const inbound = {
  type: "message",
  id: "p1",
  server: "pi-super",
  channel: "grandma",
  nick: "grandma",
  content: "read me the letter",
} as const;

describe("IpcRoomMonitor", () => {
  it("fromRuntime returns [] unless the ipc room is enabled", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();
    const runtime = createTestRuntime({
      history,
      configData: { rooms: { common: { command: baseCommandConfig() } } },
      authStorage: AuthStore.inMemory(),
    });

    expect(IpcRoomMonitor.fromRuntime(runtime)).toEqual([]);
    await history.close();
  });

  it("requires a botName, since there is no server to ask for a nick", () => {
    expect(
      () => new IpcRoomMonitor({ roomConfig: {}, commandHandler: { handleIncomingMessage: async () => {} }, channel: new FakeChannel() }),
    ).toThrow("rooms.ipc.botName");
  });

  it("rejects malformed inbound messages", () => {
    expect(() => parseIpcInbound({ ...inbound, type: "hello" })).toThrow("unknown message type");
    expect(() => parseIpcInbound({ ...inbound, content: "" })).toThrow("message.content");
  });

  it("delivers responses whole and reports when the request is done", async () => {
    const channel = new FakeChannel();
    let seen: RoomMessage | undefined;
    const letter = `Dear Anna,\n\n${"Happy birthday! ".repeat(60)}\n\nLove, Grandma`;
    const monitor = new IpcRoomMonitor({
      roomConfig: { botName: "super" },
      channel,
      commandHandler: {
        handleIncomingMessage: async (message, options) => {
          seen = message;
          await options?.sendResponse?.("Of course, here it is.");
          await options?.sendResponse?.(letter);
        },
      },
    });

    await monitor.processMessage(parseIpcInbound(inbound));

    expect(seen).toMatchObject({
      serverTag: "ipc:pi-super",
      channelName: "grandma",
      arc: "ipc:pi-super#grandma",
      nick: "grandma",
      mynick: "super",
      content: "read me the letter",
      isDirect: true,
      isPrivate: true,
    });
    expect(channel.sent).toEqual([
      { type: "response", id: "p1", server: "pi-super", channel: "grandma", text: "Of course, here it is." },
      // no IRC-style splitting, truncation or line flattening
      { type: "response", id: "p1", server: "pi-super", channel: "grandma", text: letter },
      { type: "done", id: "p1" },
    ]);
  });

  it("reports done even when handling fails", async () => {
    const channel = new FakeChannel();
    const monitor = new IpcRoomMonitor({
      roomConfig: { botName: "super" },
      channel,
      commandHandler: {
        handleIncomingMessage: async () => {
          throw new Error("model down");
        },
      },
    });

    await expect(monitor.processMessage(parseIpcInbound(inbound))).rejects.toThrow("model down");
    expect(channel.sent).toEqual([{ type: "done", id: "p1" }]);
  });

  it("does not wait forever for work nobody will hear", async () => {
    const channel = new FakeChannel();
    const monitor = new IpcRoomMonitor({
      roomConfig: { botName: "super" },
      channel,
      drainMs: 20,
      commandHandler: { handleIncomingMessage: () => new Promise<void>(() => {}) },
    });
    const running = monitor.run();
    channel.deliver(inbound);
    channel.hangUp();
    await running;
  });

  it("survives a parent that is already gone", async () => {
    const channel = new FakeChannel();
    channel.send = () => Promise.reject(new Error("IPC channel closed"));
    const warn = vi.fn();
    const monitor = new IpcRoomMonitor({
      roomConfig: { botName: "super" },
      channel,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      commandHandler: {
        handleIncomingMessage: async (_message, options) => {
          await options?.sendResponse?.("too late");
        },
      },
    });
    await monitor.processMessage(parseIpcInbound(inbound));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledWith("IPC send failed", expect.any(Error));
  });

  it("runs until the parent hangs up, finishing what is in flight", async () => {
    const channel = new FakeChannel();
    const cancelProactive = vi.fn();
    let finish: () => void = () => {};
    const monitor = new IpcRoomMonitor({
      roomConfig: { botName: "super" },
      channel,
      commandHandler: {
        cancelProactive,
        handleIncomingMessage: async (_message, options) => {
          await new Promise<void>((resolve) => (finish = resolve));
          await options?.sendResponse?.("done thinking");
        },
      },
    });

    let stopped = false;
    const running = monitor.run().then(() => (stopped = true));
    expect(channel.sent).toEqual([{ type: "ready", mynick: "super" }]);

    channel.deliver({ type: "nonsense" }); // dropped, not fatal
    channel.deliver(inbound);
    channel.hangUp();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    expect(cancelProactive).toHaveBeenCalled();

    finish();
    await running;
    expect(channel.sent.slice(1)).toEqual([
      { type: "response", id: "p1", server: "pi-super", channel: "grandma", text: "done thinking" },
      { type: "done", id: "p1" },
    ]);
  });
});
