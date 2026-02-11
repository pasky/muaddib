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

  it("normalizes Discord mention prefixes with bot id and preserves cleaned payload", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let seenMessage = "";

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message) => {
          seenMessage = message.content;
          return null;
        },
      },
    });

    await monitor.processMessageEvent({
      guildId: "guild-1",
      channelId: "chan-1",
      username: "alice",
      content: "<@!999>, hi there",
      mynick: "muaddib",
      botUserId: "999",
      mentionsBot: true,
    });

    expect(seenMessage).toBe("hi there");

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

  it("maps thread fields for context lookup and reply semantics", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    await history.addMessage({
      serverTag: "discord:Rossum",
      channelName: "general",
      nick: "alice",
      mynick: "muaddib",
      content: "thread-start",
      platformId: "thread-1",
    });

    let seenThreadId: string | undefined;
    let seenThreadStarterId: number | undefined;
    const sendOptions: Array<{ replyToMessageId?: string; mentionAuthor?: boolean }> = [];

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      sender: {
        sendMessage: async (_channelId, _message, options) => {
          sendOptions.push(options ?? {});
        },
      },
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message, options) => {
          seenThreadId = message.threadId;
          seenThreadStarterId = message.threadStarterId;
          await options.sendResponse?.("ok");
          return { response: "ok" };
        },
      },
    });

    await monitor.processMessageEvent({
      guildId: "123456789",
      guildName: "Rossum",
      channelId: "chan-1",
      channelName: "general",
      messageId: "msg-42",
      threadId: "thread-1",
      username: "alice",
      content: "muaddib: hello",
      mynick: "muaddib",
      mentionsBot: true,
    });

    expect(seenThreadId).toBe("thread-1");
    expect(seenThreadStarterId).toBeGreaterThan(0);
    expect(sendOptions).toEqual([
      {
        replyToMessageId: "msg-42",
        mentionAuthor: true,
      },
    ]);

    await history.close();
  });

  it("updates edited Discord message content by platform id", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    await history.addMessage({
      serverTag: "discord:Rossum",
      channelName: "general",
      nick: "alice",
      mynick: "muaddib",
      content: "hello",
      platformId: "msg-42",
    });

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async () => null,
      },
    });

    await monitor.processMessageEditEvent({
      kind: "message_edit",
      guildId: "123456789",
      guildName: "Rossum",
      channelId: "chan-1",
      channelName: "general",
      messageId: "msg-42",
      username: "alice",
      content: "edited message",
    });

    const rows = await history.getFullHistory("discord:Rossum", "general");
    expect(rows[0].message).toBe("<alice> edited message");

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

  it("retries Discord send once when sender returns a rate-limit error", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let sendAttempts = 0;
    const retryEvents: Array<{ type: string; retryable: boolean }> = [];

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      onSendRetryEvent: (event) => {
        retryEvents.push({ type: event.type, retryable: event.retryable });
      },
      sender: {
        sendMessage: async () => {
          sendAttempts += 1;
          if (sendAttempts === 1) {
            const error = new Error("rate limited") as Error & {
              status?: number;
              retryAfterMs?: number;
            };
            error.status = 429;
            error.retryAfterMs = 0;
            throw error;
          }
        },
      },
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (_message, options) => {
          await options.sendResponse?.("ok");
          return { response: "ok" };
        },
      },
    });

    await expect(
      monitor.processMessageEvent({
        channelId: "chan-1",
        username: "alice",
        content: "muaddib: hi",
        mynick: "muaddib",
        mentionsBot: true,
      }),
    ).resolves.toBeUndefined();

    expect(sendAttempts).toBe(2);
    expect(retryEvents).toEqual([{ type: "retry", retryable: true }]);

    await history.close();
  });

  it("fails fast on non-rate-limit Discord send errors", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let sendAttempts = 0;
    const retryEvents: Array<{ type: string; retryable: boolean }> = [];

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      onSendRetryEvent: (event) => {
        retryEvents.push({ type: event.type, retryable: event.retryable });
      },
      sender: {
        sendMessage: async () => {
          sendAttempts += 1;
          throw new Error("forbidden");
        },
      },
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (_message, options) => {
          await options.sendResponse?.("ok");
          return { response: "ok" };
        },
      },
    });

    await expect(
      monitor.processMessageEvent({
        channelId: "chan-1",
        username: "alice",
        content: "muaddib: hi",
        mynick: "muaddib",
        mentionsBot: true,
      }),
    ).rejects.toThrow("forbidden");

    expect(sendAttempts).toBe(1);
    expect(retryEvents).toEqual([{ type: "failed", retryable: false }]);

    await history.close();
  });

  it("disconnects event source when sender connect fails after startup connect", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let eventSourceConnectCalls = 0;
    let eventSourceDisconnectCalls = 0;
    let senderDisconnectCalls = 0;

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      eventSource: {
        connect: async () => {
          eventSourceConnectCalls += 1;
        },
        disconnect: async () => {
          eventSourceDisconnectCalls += 1;
        },
        receiveEvent: async () => null,
      },
      sender: {
        connect: async () => {
          throw new Error("sender connect failed");
        },
        disconnect: async () => {
          senderDisconnectCalls += 1;
        },
        sendMessage: async () => {},
      },
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async () => null,
      },
    });

    await expect(monitor.run()).rejects.toThrow("sender connect failed");
    expect(eventSourceConnectCalls).toBe(1);
    expect(eventSourceDisconnectCalls).toBe(1);
    expect(senderDisconnectCalls).toBe(0);

    await history.close();
  });

  it("keeps event loop alive after a single handler failure", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const processed: string[] = [];
    let offset = 0;
    let connectCalls = 0;
    let disconnectCalls = 0;

    const monitor = new DiscordRoomMonitor({
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
              channelId: "chan-1",
              username: "alice",
              content: "first",
              mynick: "muaddib",
            },
            {
              channelId: "chan-1",
              username: "alice",
              content: "second",
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
