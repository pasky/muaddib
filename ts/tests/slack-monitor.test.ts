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

  it("normalizes repeated leading mention prefixes using Slack bot id + bot nick", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let seenText = "";

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message) => {
          seenText = message.content;
          return null;
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      username: "alice",
      text: "<@B123> <@B123>: ping",
      mynick: "muaddib",
      botUserId: "B123",
      mentionsBot: true,
    });

    expect(seenText).toBe("ping");

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

  it("starts reply thread in channels by default and aligns RoomMessage thread context", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let seenThreadId: string | undefined;
    let seenResponseThreadId: string | undefined;
    let sentThreadTs: string | undefined;

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      sender: {
        sendMessage: async (_channelId, _text, options) => {
          sentThreadTs = options?.threadTs;
        },
      },
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message, options) => {
          seenThreadId = message.threadId;
          seenResponseThreadId = message.responseThreadId;
          await options.sendResponse?.("ok");
          return { response: "ok" };
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      workspaceName: "Rossum",
      channelId: "C123",
      channelName: "#general",
      username: "alice",
      text: "muaddib: hello",
      mynick: "muaddib",
      messageTs: "1700000000.2000",
      channelType: "channel",
      mentionsBot: true,
    });

    expect(seenThreadId).toBe("1700000000.2000");
    expect(seenResponseThreadId).toBe("1700000000.2000");
    expect(sentThreadTs).toBe("1700000000.2000");

    await history.close();
  });

  it("keeps DM replies non-threaded by default", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let seenResponseThreadId: string | undefined;
    let sentThreadTs: string | undefined;

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      sender: {
        sendMessage: async (_channelId, _text, options) => {
          sentThreadTs = options?.threadTs;
        },
      },
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message, options) => {
          seenResponseThreadId = message.responseThreadId;
          await options.sendResponse?.("ok");
          return { response: "ok" };
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "D123",
      username: "alice",
      text: "hello",
      mynick: "muaddib",
      messageTs: "1700000000.2001",
      channelType: "im",
      isDirectMessage: true,
    });

    expect(seenResponseThreadId).toBeUndefined();
    expect(sentThreadTs).toBeUndefined();

    await history.close();
  });

  it("maps threaded incoming events and resolves thread starter history id", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    await history.addMessage({
      serverTag: "slack:Rossum",
      channelName: "#general",
      nick: "alice",
      mynick: "muaddib",
      content: "thread starter",
      platformId: "1700000000.1111",
    });

    let seenThreadId: string | undefined;
    let seenThreadStarterId: number | undefined;
    let sentThreadTs: string | undefined;

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      sender: {
        sendMessage: async (_channelId, _text, options) => {
          sentThreadTs = options?.threadTs;
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
      workspaceId: "T123",
      workspaceName: "Rossum",
      channelId: "C123",
      channelName: "#general",
      username: "alice",
      text: "muaddib: follow-up",
      mynick: "muaddib",
      messageTs: "1700000000.2222",
      threadTs: "1700000000.1111",
      channelType: "channel",
      mentionsBot: true,
    });

    expect(seenThreadId).toBe("1700000000.1111");
    expect(seenThreadStarterId).toBeGreaterThan(0);
    expect(sentThreadTs).toBe("1700000000.1111");

    await history.close();
  });

  it("updates edited messages by platform id with history parity", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    await history.addMessage({
      serverTag: "slack:Rossum",
      channelName: "#general",
      nick: "Alice",
      mynick: "Muaddib",
      content: "hello",
      platformId: "1700000000.1111",
    });

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async () => null,
      },
    });

    await monitor.processMessageEditEvent({
      kind: "message_edit",
      workspaceId: "T123",
      workspaceName: "Rossum",
      channelId: "C123",
      channelName: "#general",
      channelType: "channel",
      userId: "U123",
      username: "Alice",
      editedMessageTs: "1700000000.1111",
      newText: "edited message",
    });

    const rows = await history.getFullHistory("slack:Rossum", "#general");
    expect(rows[0].message).toBe("<Alice> edited message");

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

  it("retries Slack send once when sender returns a rate-limit error", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let sendAttempts = 0;
    const retryEvents: Array<{ type: string; retryable: boolean }> = [];

    const monitor = new SlackRoomMonitor({
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
              code?: string;
              retry_after?: number;
            };
            error.code = "rate_limited";
            error.retry_after = 0;
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
        workspaceId: "T123",
        channelId: "C123",
        username: "alice",
        text: "muaddib: hi",
        mynick: "muaddib",
        mentionsBot: true,
      }),
    ).resolves.toBeUndefined();

    expect(sendAttempts).toBe(2);
    expect(retryEvents).toEqual([{ type: "retry", retryable: true }]);

    await history.close();
  });

  it("fails fast on non-rate-limit Slack send errors", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let sendAttempts = 0;
    const retryEvents: Array<{ type: string; retryable: boolean }> = [];

    const monitor = new SlackRoomMonitor({
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
        workspaceId: "T123",
        channelId: "C123",
        username: "alice",
        text: "muaddib: hi",
        mynick: "muaddib",
        mentionsBot: true,
      }),
    ).rejects.toThrow("forbidden");

    expect(sendAttempts).toBe(1);
    expect(retryEvents).toEqual([{ type: "failed", retryable: false }]);

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
