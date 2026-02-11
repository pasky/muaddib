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
        handleIncomingMessage: async (message, options) => {
          executeCalls.push(message.content);
          if (options.isDirect && options.sendResponse) {
            await options.sendResponse("line1\nline2");
          }
          await history.addMessage(message);
          await history.addMessage({
            ...message,
            nick: message.mynick,
            content: "line1\nline2",
          });
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
    let directFlag = false;

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socket_path: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message, options) => {
          directFlag = options.isDirect;
          await history.addMessage(message);
          return null;
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

    expect(directFlag).toBe(false);
    expect(sender.sent).toHaveLength(0);

    const historyRows = await history.getFullHistory("libera", "#test");
    expect(historyRows).toHaveLength(1);

    await history.close();
  });

  it("refreshes cached mynick after varlink reconnect so direct detection stays correct", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const responses: Array<Record<string, unknown> | null> = [
      {
        parameters: {
          event: {
            type: "message",
            subtype: "public",
            server: "libera",
            target: "#test",
            nick: "alice",
            message: "muaddib: first",
          },
        },
      },
      null,
      {
        parameters: {
          event: {
            type: "message",
            subtype: "public",
            server: "libera",
            target: "#test",
            nick: "alice",
            message: "muaddib2: second",
          },
        },
      },
      {
        error: "done",
      },
    ];

    let offset = 0;
    const seen: Array<{ mynick: string; content: string; isDirect: boolean }> = [];

    const sender = {
      connectionGeneration: -1,
      async connect(): Promise<void> {
        this.connectionGeneration += 1;
      },
      async disconnect(): Promise<void> {},
      async sendMessage(): Promise<boolean> {
        return true;
      },
      async getServerNick(): Promise<string | null> {
        return this.connectionGeneration === 0 ? "muaddib" : "muaddib2";
      },
    };

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socket_path: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message, options) => {
          seen.push({
            mynick: message.mynick,
            content: message.content,
            isDirect: options.isDirect,
          });
          return null;
        },
      },
      varlinkEvents: {
        connect: async () => {},
        disconnect: async () => {},
        waitForEvents: async () => {},
        receiveResponse: async () => {
          const response = responses[offset];
          offset += 1;
          return response ?? null;
        },
      },
      varlinkSender: sender,
    });

    await expect(monitor.run()).resolves.toBeUndefined();

    expect(seen).toEqual([
      {
        mynick: "muaddib",
        content: "first",
        isDirect: true,
      },
      {
        mynick: "muaddib2",
        content: "second",
        isDirect: true,
      },
    ]);

    await history.close();
  });

  it("keeps event loop alive after a single handler failure", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const responses: Array<Record<string, unknown>> = [
      {
        parameters: {
          event: {
            type: "message",
            subtype: "public",
            server: "libera",
            target: "#test",
            nick: "alice",
            message: "first",
          },
        },
      },
      {
        parameters: {
          event: {
            type: "message",
            subtype: "public",
            server: "libera",
            target: "#test",
            nick: "alice",
            message: "second",
          },
        },
      },
      {
        error: "done",
      },
    ];

    let offset = 0;
    const processed: string[] = [];

    const sender = new FakeSender();
    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socket_path: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message) => {
          processed.push(message.content);
          if (processed.length === 1) {
            throw new Error("boom");
          }
          return null;
        },
      },
      varlinkEvents: {
        connect: async () => {},
        disconnect: async () => {},
        waitForEvents: async () => {},
        receiveResponse: async () => {
          const response = responses[offset];
          offset += 1;
          return response ?? null;
        },
      },
      varlinkSender: sender,
    });

    await expect(monitor.run()).resolves.toBeUndefined();
    expect(processed).toEqual(["first", "second"]);

    await history.close();
  });
});
