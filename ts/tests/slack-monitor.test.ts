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
});
