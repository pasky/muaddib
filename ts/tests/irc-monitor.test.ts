import { describe, expect, it } from "vitest";

import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { IrcRoomMonitor } from "../src/rooms/irc/monitor.js";

class FakeEventsClient {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async waitForEvents(): Promise<void> {}
  async receiveResponse(): Promise<Record<string, unknown> | null> {
    return null;
  }
}

class FakeSender {
  sent: Array<{ target: string; message: string; server: string }> = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getServerNick(): Promise<string | null> {
    return "muaddib";
  }

  async sendMessage(target: string, message: string, server: string): Promise<boolean> {
    this.sent.push({ target, message, server });
    return true;
  }
}

describe("IrcRoomMonitor", () => {
  it("routes direct message events into command handler and sender", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const sender = new FakeSender();
    const executeCalls: string[] = [];

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socket_path: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        execute: async (message) => {
          executeCalls.push(message.content);
          return { response: "line1\nline2" };
        },
      },
      varlinkEvents: new FakeEventsClient(),
      varlinkSender: sender,
    });

    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "alice",
      message: "muaddib: hello there",
    });

    expect(executeCalls).toEqual(["hello there"]);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toEqual({
      target: "#test",
      message: "line1; line2",
      server: "libera",
    });

    const historyRows = await history.getFullHistory("libera", "#test");
    expect(historyRows).toHaveLength(2);

    await history.close();
  });

  it("ignores passive public messages when not addressed directly", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const sender = new FakeSender();
    let executed = false;

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socket_path: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        execute: async () => {
          executed = true;
          return { response: "unused" };
        },
      },
      varlinkEvents: new FakeEventsClient(),
      varlinkSender: sender,
    });

    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "alice",
      message: "just chatting",
    });

    expect(executed).toBe(false);
    expect(sender.sent).toHaveLength(0);

    const historyRows = await history.getFullHistory("libera", "#test");
    expect(historyRows).toHaveLength(1);

    await history.close();
  });
});
