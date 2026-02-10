import { describe, expect, it } from "vitest";

import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { SlackRoomMonitor } from "../src/rooms/slack/monitor.js";

describe("SlackRoomMonitor", () => {
  it("maps direct mention event to shared command handler with cleaned text", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let seenText = "";
    let isDirect = false;

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      sender: {
        sendMessage: async () => {},
      },
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message, options) => {
          seenText = message.content;
          isDirect = options.isDirect;
          return { response: "ok" };
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      username: "alice",
      text: "muaddib: hi",
      mynick: "muaddib",
      mentionsBot: true,
    });

    expect(isDirect).toBe(true);
    expect(seenText).toBe("hi");

    await history.close();
  });

  it("maps workspace/message identity fields with Python parity semantics", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let mappedServerTag = "";
    let mappedPlatformId = "";
    let mappedNick = "";
    let mappedMynick = "";

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message) => {
          mappedServerTag = message.serverTag;
          mappedPlatformId = message.platformId ?? "";
          mappedNick = message.nick;
          mappedMynick = message.mynick;
          return null;
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      workspaceName: "Rossum",
      channelId: "C123",
      channelName: "#general",
      userId: "U123",
      username: "Alice",
      text: "hello",
      messageTs: "1700000000.1111",
      mynick: "Muaddib Bot",
    });

    expect(mappedServerTag).toBe("slack:Rossum");
    expect(mappedPlatformId).toBe("1700000000.1111");
    expect(mappedNick).toBe("Alice");
    expect(mappedMynick).toBe("Muaddib Bot");

    await history.close();
  });

  it("ignores users from ignore list through shared command handler", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let called = false;

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        shouldIgnoreUser: () => true,
        handleIncomingMessage: async () => {
          called = true;
          return null;
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      username: "alice",
      text: "hello",
      mynick: "muaddib",
    });

    expect(called).toBe(false);

    await history.close();
  });

  it("keeps event loop alive after a single handler failure", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const processed: string[] = [];
    let offset = 0;
    let connectCalls = 0;
    let disconnectCalls = 0;

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      eventSource: {
        connect: async () => {
          connectCalls += 1;
        },
        disconnect: async () => {
          disconnectCalls += 1;
        },
        receiveEvent: async () => {
          const events = [
            {
              workspaceId: "T123",
              channelId: "C123",
              username: "alice",
              text: "first",
              mynick: "muaddib",
            },
            {
              workspaceId: "T123",
              channelId: "C123",
              username: "alice",
              text: "second",
              mynick: "muaddib",
            },
          ];

          const event = events[offset];
          offset += 1;
          return event ?? null;
        },
      },
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
    });

    await expect(monitor.run()).resolves.toBeUndefined();
    expect(processed).toEqual(["first", "second"]);
    expect(connectCalls).toBe(1);
    expect(disconnectCalls).toBe(1);

    await history.close();
  });
});
