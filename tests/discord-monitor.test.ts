import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { RuntimeLogWriter } from "../src/app/logging.js";
import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { DiscordRoomMonitor } from "../src/rooms/discord/monitor.js";
import { DiscordGatewayTransport } from "../src/rooms/discord/transport.js";
import { buildArc } from "../src/rooms/message.js";
import { createDeferred, createTempHistoryStore } from "./test-helpers.js";
import { createTestRuntime } from "./test-runtime.js";

function baseCommandConfig() {
  return {
    historySize: 40,
    defaultMode: "classifier:serious",
    modes: {
      serious: {
        model: "openai:gpt-4o-mini",
        prompt: "You are {mynick}",
        triggers: {
          "!s": {},
        },
      },
    },
    modeClassifier: {
      model: "openai:gpt-4o-mini",
      labels: {
        EASY_SERIOUS: "!s",
      },
      fallbackLabel: "EASY_SERIOUS",
    },
  };
}

function buildRuntime(configData: Record<string, unknown>, history: ChatHistoryStore, authStorage: AuthStorage = AuthStorage.inMemory()) {
  return createTestRuntime({ history, configData, authStorage });
}

describe("DiscordRoomMonitor", () => {
  it("fromRuntime returns [] when Discord is disabled", async () => {
    const history = createTempHistoryStore(20);

    const monitors = await DiscordRoomMonitor.fromRuntime(buildRuntime({
      rooms: {
        common: {
          command: baseCommandConfig(),
        },
        discord: {
          enabled: false,
        },
      },
    }, history));

    expect(monitors).toEqual([]);
    await history.close();
  });

  it("fromRuntime validates token when Discord is enabled", async () => {
    const history = createTempHistoryStore(20);

    await expect(DiscordRoomMonitor.fromRuntime(buildRuntime({
      rooms: {
        common: {
          command: baseCommandConfig(),
        },
        discord: {
          enabled: true,
        },
      },
    }, history))).rejects.toThrow("'discord' API key is missing from auth.json");

    await history.close();
  });

  it("fromRuntime builds Discord monitor when enabled", async () => {
    const history = createTempHistoryStore(20);

    const monitors = await DiscordRoomMonitor.fromRuntime(buildRuntime({
      rooms: {
        common: {
          command: baseCommandConfig(),
        },
        discord: {
          enabled: true,
          botName: "muaddib",
        },
      },
    }, history, AuthStorage.inMemory({ discord: { type: "api_key", key: "discord-token" } })));

    expect(monitors).toHaveLength(1);
    await history.close();
  });

  it("maps direct mention event to shared command handler with cleaned content", async () => {
    const history = createTempHistoryStore(20);

    let seenMessage = "";
    let isDirect: boolean | undefined = false;
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
        handleIncomingMessage: async (message, options) => {
          seenMessage = message.content;
          isDirect = message.isDirect;
          await options?.sendResponse?.("ok");
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

  it("sets and clears Discord typing indicator around direct command handling", async () => {
    const history = createTempHistoryStore(20);

    const typingSetCalls: string[] = [];
    const typingClearCalls: string[] = [];

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      sender: {
        setTypingIndicator: async (channelId) => {
          typingSetCalls.push(channelId);
        },
        clearTypingIndicator: async (channelId) => {
          typingClearCalls.push(channelId);
        },
        sendMessage: async () => {},
      },
      commandHandler: {
        handleIncomingMessage: async (_message, options) => {
          await options?.sendResponse?.("ok");
        },
      },
    });

    await monitor.processMessageEvent({
      guildId: "guild-1",
      channelId: "chan-typing",
      username: "alice",
      content: "muaddib: hello",
      mynick: "muaddib",
      mentionsBot: true,
    });

    expect(typingSetCalls).toEqual(["chan-typing"]);
    expect(typingClearCalls).toEqual(["chan-typing"]);

    await history.close();
  });

  it("includes attachment metadata block in command content", async () => {
    const history = createTempHistoryStore(20);

    let seenContent = "";

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenContent = message.content;

        },
      },
    });

    await monitor.processMessageEvent({
      guildId: "guild-1",
      channelId: "chan-1",
      username: "alice",
      content: "muaddib: please inspect",
      mynick: "muaddib",
      mentionsBot: true,
      attachments: [
        {
          url: "https://cdn.discordapp.com/attachments/123/report.txt",
          contentType: "text/plain",
          filename: "report.txt",
          size: 512,
        },
      ],
    });

    expect(seenContent).toContain("please inspect");
    expect(seenContent).toContain("[Attachments]");
    expect(seenContent).toContain("1. text/plain (filename: report.txt) (size: 512): https://cdn.discordapp.com/attachments/123/report.txt");
    expect(seenContent).toContain("[/Attachments]");

    await history.close();
  });

  it("writes direct-message logs to Discord arc-sharded files", async () => {
    const history = createTempHistoryStore(20);

    const logsHome = await mkdtemp(join(tmpdir(), "muaddib-discord-message-logs-"));
    const fixedNow = new Date(2026, 1, 12, 14, 15, 16, 321);
    const runtimeLogs = new RuntimeLogWriter({
      muaddibHome: logsHome,
      nowProvider: () => fixedNow,
      stdout: {
        write: () => true,
      } as unknown as NodeJS.WriteStream,
    });

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      logger: runtimeLogs.getLogger("muaddib.rooms.discord.monitor"),
      logWriter: runtimeLogs,
      commandHandler: {
        handleIncomingMessage: async () => {
          runtimeLogs.getLogger("muaddib.tests.command").debug("inside discord direct handler");

        },
      },
    });

    await monitor.processMessageEvent({
      guildId: "guild-1",
      guildName: "Rossum",
      channelId: "chan-1",
      channelName: "general",
      username: "alice",
      content: "muaddib: check / parity",
      mynick: "muaddib",
      mentionsBot: true,
    });

    const datePath = fixedNow.toISOString().slice(0, 10);
    const arcDir = join(logsHome, "logs", datePath, "discord:Rossum#general");
    const arcFiles = await readdir(arcDir);

    expect(arcFiles).toHaveLength(1);
    expect(arcFiles[0]).toBe("14-15-16-alice-muaddib_check_parity.log");

    const messageLog = await readFile(join(arcDir, arcFiles[0]), "utf-8");
    expect(messageLog).toContain("inside discord direct handler");
    expect(messageLog).toContain("Processing direct Discord message");

    await rm(logsHome, { recursive: true, force: true });
    await history.close();
  });

  it("normalizes Discord mention prefixes with bot id and preserves cleaned payload", async () => {
    const history = createTempHistoryStore(20);

    let seenMessage = "";

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenMessage = message.content;

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
    const history = createTempHistoryStore(20);

    let mappedServerTag = "";
    let mappedPlatformId = "";

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          mappedServerTag = message.serverTag;
          mappedPlatformId = message.platformId ?? "";

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
    const history = createTempHistoryStore(20);

    let seenThreadId: string | undefined;
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
        handleIncomingMessage: async (message, options) => {
          seenThreadId = message.threadId;
          await options?.sendResponse?.("ok");
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
    expect(sendOptions).toEqual([
      {
        replyToMessageId: "msg-42",
        mentionAuthor: true,
      },
    ]);

    await history.close();
  });

  it("debounces rapid Discord replies by editing the previous bot message", async () => {
    const history = createTempHistoryStore(20);

    const sendCalls: Array<{ text: string; options?: { replyToMessageId?: string; mentionAuthor?: boolean } }> = [];
    const editCalls: Array<{ messageId: string; text: string }> = [];

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true, replyEditDebounceSeconds: 15 },
      history,
      sender: {
        sendMessage: async (_channelId, text, options) => {
          sendCalls.push({ text, options });
          return {
            messageId: "bot-reply-1",
          };
        },
        editMessage: async (_channelId, messageId, text) => {
          editCalls.push({ messageId, text });
          return {
            messageId,
          };
        },
      },
      commandHandler: {
        handleIncomingMessage: async (_message, options) => {
          await options?.sendResponse?.("first");
          await options?.sendResponse?.("second");
        },
      },
    });

    await monitor.processMessageEvent({
      guildId: "123456789",
      channelId: "chan-1",
      messageId: "msg-42",
      username: "alice",
      content: "muaddib: hello",
      mynick: "muaddib",
      mentionsBot: true,
    });

    expect(sendCalls).toEqual([
      {
        text: "first",
        options: {
          replyToMessageId: "msg-42",
          mentionAuthor: true,
        },
      },
    ]);
    expect(editCalls).toEqual([
      {
        messageId: "bot-reply-1",
        text: "first\nsecond",
      },
    ]);

    await history.close();
  });

  it("sends a new Discord followup when reply edit debounce is disabled", async () => {
    const history = createTempHistoryStore(20);

    const sendCalls: Array<{ text: string; options?: { replyToMessageId?: string; mentionAuthor?: boolean } }> = [];

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true, replyEditDebounceSeconds: 0 },
      history,
      sender: {
        sendMessage: async (_channelId, text, options) => {
          sendCalls.push({ text, options });
          return {
            messageId: sendCalls.length === 1 ? "bot-reply-1" : "bot-reply-2",
          };
        },
        editMessage: async () => {
          throw new Error("editMessage should not be called when debounce is disabled");
        },
      },
      commandHandler: {
        handleIncomingMessage: async (_message, options) => {
          await options?.sendResponse?.("first");
          await options?.sendResponse?.("second");
        },
      },
    });

    await monitor.processMessageEvent({
      guildId: "123456789",
      channelId: "chan-1",
      messageId: "msg-42",
      username: "alice",
      content: "muaddib: hello",
      mynick: "muaddib",
      mentionsBot: true,
    });

    expect(sendCalls).toEqual([
      {
        text: "first",
        options: {
          replyToMessageId: "msg-42",
          mentionAuthor: true,
        },
      },
      {
        text: "second",
        options: {
          replyToMessageId: "bot-reply-1",
          mentionAuthor: false,
        },
      },
    ]);

    await history.close();
  });

  it("updates edited Discord message content by platform id", async () => {
    const history = createTempHistoryStore(20);

    await history.addMessage({
      serverTag: "discord:Rossum",
      channelName: "general",
      arc: "discord:Rossum#general",
      nick: "alice",
      mynick: "muaddib",
      content: "hello",
      platformId: "msg-42",
    });

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async () => {},
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

    const arc = buildArc("discord:Rossum", "general");
    const rows = await history.getFullHistory(arc);
    // JSONL store keeps both original and edit line; the edit is appended last
    expect(rows).toHaveLength(2);
    expect(rows[0].message).toBe("<alice> hello");
    expect(rows[1].message).toBe("<alice> edited message");

    await history.close();
  });

  it("sets trusted=true when authorId matches Discord allowlist", async () => {
    const history = createTempHistoryStore(20);

    let seenTrusted: boolean | undefined;

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true, userAllowlist: ["alice_123456"] },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenTrusted = message.trusted;
        },
      },
    });

    await monitor.processMessageEvent({
      channelId: "chan-1",
      username: "alice",
      authorId: "123456",
      content: "hello",
      mynick: "muaddib",
    });

    expect(seenTrusted).toBe(true);
    await history.close();
  });

  it("sets trusted=false when authorId does not match Discord allowlist", async () => {
    const history = createTempHistoryStore(20);

    let seenTrusted: boolean | undefined;

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true, userAllowlist: ["alice_123456"] },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenTrusted = message.trusted;
        },
      },
    });

    await monitor.processMessageEvent({
      channelId: "chan-1",
      username: "bob",
      authorId: "999999",
      content: "hello",
      mynick: "muaddib",
    });

    expect(seenTrusted).toBe(false);
    await history.close();
  });

  it("leaves trusted undefined when no Discord allowlist is configured", async () => {
    const history = createTempHistoryStore(20);

    let seenTrusted: boolean | undefined = true; // sentinel

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenTrusted = message.trusted;
        },
      },
    });

    await monitor.processMessageEvent({
      channelId: "chan-1",
      username: "alice",
      authorId: "123456",
      content: "hello",
      mynick: "muaddib",
    });

    expect(seenTrusted).toBeUndefined();
    await history.close();
  });

  it("passes passive messages with isDirect=false", async () => {
    const history = createTempHistoryStore(20);

    let isDirect: boolean | undefined = true;

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          isDirect = message.isDirect;
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
    const history = createTempHistoryStore(20);

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
              retryAfter?: number;
            };
            error.status = 429;
            error.retryAfter = 0;
            throw error;
          }
        },
      },
      commandHandler: {
        handleIncomingMessage: async (_message, options) => {
          await options?.sendResponse?.("ok");
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
    const history = createTempHistoryStore(20);

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
        handleIncomingMessage: async (_message, options) => {
          await options?.sendResponse?.("ok");
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
    const history = createTempHistoryStore(20);

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
        handleIncomingMessage: async () => {},
      },
    });

    await expect(monitor.run()).rejects.toThrow("sender connect failed");
    expect(eventSourceConnectCalls).toBe(1);
    expect(eventSourceDisconnectCalls).toBe(1);
    expect(senderDisconnectCalls).toBe(0);

    await history.close();
  });

  it("reconnects receive loop when event source errors and reconnect policy is enabled", async () => {
    const history = createTempHistoryStore(20);

    let connectCalls = 0;
    let disconnectCalls = 0;
    let emittedAfterReconnect = false;
    const processed: string[] = [];

    const monitor = new DiscordRoomMonitor({
      roomConfig: {
        enabled: true,
        reconnect: {
          enabled: true,
          delayMs: 0,
          maxAttempts: 2,
        },
      },
      history,
      eventSource: {
        connect: async () => {
          connectCalls += 1;
        },
        disconnect: async () => {
          disconnectCalls += 1;
        },
        receiveEvent: async () => {
          if (connectCalls === 1) {
            throw new Error("socket disconnected");
          }

          if (!emittedAfterReconnect) {
            emittedAfterReconnect = true;
            return {
              channelId: "chan-1",
              username: "alice",
              content: "muaddib: second session",
              mynick: "muaddib",
              mentionsBot: true,
            };
          }

          return null;
        },
      },
      commandHandler: {
        handleIncomingMessage: async (message) => {
          processed.push(message.content);
        },
      },
    });

    await expect(monitor.run()).resolves.toBeUndefined();
    expect(processed).toEqual(["second session"]);
    expect(connectCalls).toBe(2);
    expect(disconnectCalls).toBe(2);

    await history.close();
  });

  it("stops gracefully on null Discord events even when reconnect is enabled", async () => {
    const history = createTempHistoryStore(20);

    let connectCalls = 0;
    let disconnectCalls = 0;

    const monitor = new DiscordRoomMonitor({
      roomConfig: {
        enabled: true,
        reconnect: {
          enabled: true,
          delayMs: 0,
          maxAttempts: 3,
        },
      },
      history,
      eventSource: {
        connect: async () => {
          connectCalls += 1;
        },
        disconnect: async () => {
          disconnectCalls += 1;
        },
        receiveEvent: async () => null,
      },
      commandHandler: {
        handleIncomingMessage: async () => {},
      },
    });

    await expect(monitor.run()).resolves.toBeUndefined();
    expect(connectCalls).toBe(1);
    expect(disconnectCalls).toBe(1);

    await history.close();
  });

  it("fails after Discord reconnect max_attempts is exhausted", async () => {
    const history = createTempHistoryStore(20);

    let connectCalls = 0;
    let disconnectCalls = 0;

    const monitor = new DiscordRoomMonitor({
      roomConfig: {
        enabled: true,
        reconnect: {
          enabled: true,
          delayMs: 0,
          maxAttempts: 2,
        },
      },
      history,
      eventSource: {
        connect: async () => {
          connectCalls += 1;
        },
        disconnect: async () => {
          disconnectCalls += 1;
        },
        receiveEvent: async () => {
          throw new Error("socket disconnected");
        },
      },
      commandHandler: {
        handleIncomingMessage: async () => {},
      },
    });

    await expect(monitor.run()).rejects.toThrow("socket disconnected");
    expect(connectCalls).toBe(3);
    expect(disconnectCalls).toBe(3);

    await history.close();
  });

  it("does not reconnect Discord monitor when reconnect policy is disabled", async () => {
    const history = createTempHistoryStore(20);

    let connectCalls = 0;
    let disconnectCalls = 0;

    const monitor = new DiscordRoomMonitor({
      roomConfig: {
        enabled: true,
        reconnect: {
          enabled: false,
          delayMs: 0,
          maxAttempts: 2,
        },
      },
      history,
      eventSource: {
        connect: async () => {
          connectCalls += 1;
        },
        disconnect: async () => {
          disconnectCalls += 1;
        },
        receiveEvent: async () => {
          throw new Error("socket disconnected");
        },
      },
      commandHandler: {
        handleIncomingMessage: async () => {},
      },
    });

    await expect(monitor.run()).rejects.toThrow("socket disconnected");
    expect(connectCalls).toBe(1);
    expect(disconnectCalls).toBe(1);

    await history.close();
  });

  it("keeps event loop alive after a single handler failure", async () => {
    const history = createTempHistoryStore(20);

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
        handleIncomingMessage: async (message) => {
          processed.push(message.content);
          if (processed.length === 1) {
            throw new Error("boom");
          }

        },
      },
    });

    await expect(monitor.run()).resolves.toBeUndefined();
    expect(processed).toEqual(["first", "second"]);
    expect(connectCalls).toBe(1);
    expect(disconnectCalls).toBe(1);

    await history.close();
  });

  it("dequeues later Discord events before earlier handlers finish and waits for in-flight work on shutdown", async () => {
    const history = createTempHistoryStore(20);

    const allowFirstMessageToFinish = createDeferred<void>();
    const firstMessageStarted = createDeferred<void>();
    const startedMessages: string[] = [];
    let receiveEventCalls = 0;
    let runFinished = false;

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      eventSource: {
        receiveEvent: async () => {
          receiveEventCalls += 1;
          if (receiveEventCalls === 1) {
            return {
              channelId: "chan-1",
              username: "alice",
              content: "muaddib: first",
              mynick: "muaddib",
              mentionsBot: true,
            };
          }

          if (receiveEventCalls === 2) {
            return {
              channelId: "chan-1",
              username: "alice",
              content: "muaddib: second",
              mynick: "muaddib",
              mentionsBot: true,
            };
          }

          return null;
        },
      },
      commandHandler: {
        handleIncomingMessage: async (message) => {
          startedMessages.push(message.content);
          if (message.content === "first") {
            firstMessageStarted.resolve();
            await allowFirstMessageToFinish.promise;
          }
        },
      },
    });

    const runPromise = monitor.run().then(() => {
      runFinished = true;
    });

    await firstMessageStarted.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(startedMessages).toEqual(["first", "second"]);
    expect(receiveEventCalls).toBe(3);
    expect(runFinished).toBe(false);

    allowFirstMessageToFinish.resolve();
    await runPromise;
    expect(runFinished).toBe(true);

    await history.close();
  });

  it("preserves other users' resolved mentions in direct content", async () => {
    const history = createTempHistoryStore(20);

    let seenMessage = "";

    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenMessage = message.content;

        },
      },
    });

    // In production, transport delivers cleanContent where mentions are
    // already resolved to @Username by discord.js.
    await monitor.processMessageEvent({
      guildId: "guild-1",
      channelId: "chan-1",
      username: "alice",
      content: "@muaddib @Bob hey check this",
      mynick: "muaddib",
      botUserId: "999",
      mentionsBot: true,
    });

    // Bot name prefix is stripped, but @Bob (another user) is preserved
    expect(seenMessage).toBe("@Bob hey check this");

    await history.close();
  });
});

/** Create a fake Discord.js Collection (Map with a `find` method). */
function fakeCollection<V>(entries: Array<[string, V]>): Map<string, V> & { find(fn: (v: V) => boolean): V | undefined } {
  const map = new Map(entries) as Map<string, V> & { find(fn: (v: V) => boolean): V | undefined };
  map.find = (fn: (v: V) => boolean) => {
    for (const v of map.values()) {
      if (fn(v)) return v;
    }
    return undefined;
  };
  return map;
}

describe("DiscordGatewayTransport.resolveChannelId", () => {
  it("returns channelName as fallback when no guilds are cached", async () => {
    const transport = Object.create(DiscordGatewayTransport.prototype) as DiscordGatewayTransport;
    (transport as any).client = {
      guilds: {
        cache: new Map(),
      },
    };

    const result = await transport.resolveChannelId("general", "MyGuild");
    expect(result).toBe("general");
  });

  it("resolves channel name to id from guild cache", async () => {
    const transport = Object.create(DiscordGatewayTransport.prototype) as DiscordGatewayTransport;
    (transport as any).client = {
      guilds: {
        cache: new Map([
          ["guild-1", {
            name: "MyGuild",
            id: "guild-1",
            channels: {
              cache: fakeCollection([
                ["chan-123", { name: "general", id: "chan-123", isTextBased: () => true }],
                ["chan-456", { name: "random", id: "chan-456", isTextBased: () => true }],
              ]),
            },
          }],
        ]),
      },
    };

    const result = await transport.resolveChannelId("general", "MyGuild");
    expect(result).toBe("chan-123");
  });

  it("filters by guild identifier", async () => {
    const transport = Object.create(DiscordGatewayTransport.prototype) as DiscordGatewayTransport;
    (transport as any).client = {
      guilds: {
        cache: new Map([
          ["guild-1", {
            name: "OtherGuild",
            id: "guild-1",
            channels: {
              cache: fakeCollection([
                ["chan-999", { name: "general", id: "chan-999", isTextBased: () => true }],
              ]),
            },
          }],
        ]),
      },
    };

    // Guild name doesn't match, so fallback
    const result = await transport.resolveChannelId("general", "MyGuild");
    expect(result).toBe("general");
  });
});
