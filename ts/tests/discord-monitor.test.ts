import { describe, expect, it } from "vitest";

import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { DiscordRoomMonitor } from "../src/rooms/discord/monitor.js";

describe("DiscordRoomMonitor", () => {
  it("maps direct mention event to shared command handler with cleaned content", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let seenMessage = "";
    let isDirect = false;
    const sent: string[] = [];

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      sender: {
        sendMessage: async (_channelId, message) => {
          sent.push(message);
        },
      },
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message, options) => {
          seenMessage = message.content;
          isDirect = options.isDirect;
          await options.sendResponse?.("ok");
          return { response: "ok" };
        },
      },
    });

    await monitor.processMessageEvent({
      guildId: "guild-1",
      channelId: "chan-1",
      channelName: "general",
      username: "alice",
      content: "muaddib: hello",
      mynick: "muaddib",
      mentionsBot: true,
    });

    expect(isDirect).toBe(true);
    expect(seenMessage).toBe("hello");
    expect(sent).toEqual(["ok"]);

    await history.close();
  });

  it("maps serverTag/platformId using Python parity semantics", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let mappedServerTag = "";
    let mappedPlatformId = "";

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message) => {
          mappedServerTag = message.serverTag;
          mappedPlatformId = message.platformId ?? "";
          return null;
        },
      },
    });

    await monitor.processMessageEvent({
      guildId: "123456789",
      guildName: "Rossum",
      channelId: "chan-1",
      channelName: "general",
      messageId: "msg-42",
      username: "alice",
      content: "hello",
      mynick: "muaddib",
    });

    expect(mappedServerTag).toBe("discord:Rossum");
    expect(mappedPlatformId).toBe("msg-42");

    await history.close();
  });

  it("passes passive messages with isDirect=false", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let isDirect = true;

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (_message, options) => {
          isDirect = options.isDirect;
          return null;
        },
      },
    });

    await monitor.processMessageEvent({
      channelId: "chan-1",
      username: "alice",
      content: "normal chat",
      mynick: "muaddib",
    });

    expect(isDirect).toBe(false);

    await history.close();
  });
});
