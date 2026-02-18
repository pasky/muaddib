import { describe, expect, it } from "vitest";

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { SlackRoomMonitor } from "../src/rooms/slack/monitor.js";
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

describe("SlackRoomMonitor", () => {
  it("fromRuntime returns [] when Slack is disabled", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const monitors = await SlackRoomMonitor.fromRuntime(buildRuntime({
      rooms: {
        common: {
          command: baseCommandConfig(),
        },
        slack: {
          enabled: false,
        },
      },
    }, history));

    expect(monitors).toEqual([]);
    await history.close();
  });

  it("fromRuntime validates app token/workspaces when Slack is enabled", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    await expect(SlackRoomMonitor.fromRuntime(buildRuntime({
      rooms: {
        common: {
          command: baseCommandConfig(),
        },
        slack: {
          enabled: true,
        },
      },
    }, history))).rejects.toThrow("'slack-app' API key is missing from auth.json");

    await expect(SlackRoomMonitor.fromRuntime(buildRuntime({
      rooms: {
        common: {
          command: baseCommandConfig(),
        },
        slack: {
          enabled: true,
        },
      },
    }, history, AuthStorage.inMemory({ "slack-app": { type: "api_key", key: "xapp-test" } })))).rejects.toThrow("Slack room is enabled but rooms.slack.workspaces is missing.");

    await expect(SlackRoomMonitor.fromRuntime(buildRuntime({
      rooms: {
        common: {
          command: baseCommandConfig(),
        },
        slack: {
          enabled: true,
          workspaces: {
            T123: {},
          },
        },
      },
    }, history, AuthStorage.inMemory({ "slack-app": { type: "api_key", key: "xapp-test" } })))).rejects.toThrow("'slack-T123' API key is missing from auth.json");

    await history.close();
  });

  it("fromRuntime builds one Slack monitor per workspace when enabled", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const monitors = await SlackRoomMonitor.fromRuntime(buildRuntime({
      rooms: {
        common: {
          command: baseCommandConfig(),
        },
        slack: {
          enabled: true,
          workspaces: {
            T123: {},
            T456: {},
          },
        },
      },
    }, history, AuthStorage.inMemory({
      "slack-app": { type: "api_key", key: "xapp-test" },
      "slack-T123": { type: "api_key", key: "xoxb-1" },
      "slack-T456": { type: "api_key", key: "xoxb-2" },
    })));

    expect(monitors).toHaveLength(2);
    await history.close();
  });

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

  it("includes Slack attachment context and propagates secrets", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let seenText = "";
    let seenSecrets: Record<string, unknown> | undefined;

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenText = message.content;
          seenSecrets = message.secrets as Record<string, unknown> | undefined;
          return null;
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
      files: [
        {
          mimetype: "text/plain",
          name: "notes.txt",
          size: 1024,
          urlPrivate: "https://files.slack.com/files-pri/T123-F456/notes.txt",
        },
      ],
      secrets: {
        http_header_prefixes: {
          "https://files.slack.com/": {
            Authorization: "Bearer xoxb-secret",
          },
        },
      },
    });

    expect(seenText).toContain("hi");
    expect(seenText).toContain("[Attachments]");
    expect(seenText).toContain("1. text/plain (filename: notes.txt) (size: 1024): https://files.slack.com/files-pri/T123-F456/notes.txt");
    expect(seenText).toContain("[/Attachments]");
    expect(seenSecrets).toEqual({
      http_header_prefixes: {
        "https://files.slack.com/": {
          Authorization: "Bearer xoxb-secret",
        },
      },
    });

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

  it("strips @botname prefix from direct messages", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let seenText = "";

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
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
      text: "@muaddib: hello there",
      mynick: "muaddib",
      mentionsBot: true,
    });

    expect(seenText).toBe("hello there");

    await history.close();
  });

  it("decodes HTML entities in Slack message text", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let seenText = "";

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenText = message.content;
          return null;
        },
      },
    });

    // The text field arrives pre-normalized by the transport; simulate what
    // SlackSocketTransport.normalizeIncomingText would produce for entities
    // that go beyond the basic &amp;/&lt;/&gt; triple.
    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      channelType: "im",
      username: "alice",
      text: 'he said "hello" & it\'s <fine>',
      mynick: "muaddib",
      isDirectMessage: true,
    });

    expect(seenText).toBe('he said "hello" & it\'s <fine>');

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

  it("debounces rapid Slack replies by updating the previous bot message", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const sendCalls: Array<{ text: string; threadTs?: string }> = [];
    const updateCalls: Array<{ messageTs: string; text: string }> = [];

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true, replyEditDebounceSeconds: 15 },
      history,
      sender: {
        sendMessage: async (_channelId, text, options) => {
          sendCalls.push({ text, threadTs: options?.threadTs });
          return {
            messageTs: "1700000000.3000",
          };
        },
        updateMessage: async (_channelId, messageTs, text) => {
          updateCalls.push({ messageTs, text });
          return {
            messageTs,
          };
        },
      },
      commandHandler: {
        handleIncomingMessage: async (_message, options) => {
          await options.sendResponse?.("first");
          await options.sendResponse?.("second");
          return { response: "second" };
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      channelName: "#general",
      username: "alice",
      text: "muaddib: hello",
      mynick: "muaddib",
      messageTs: "1700000000.2000",
      channelType: "channel",
      mentionsBot: true,
    });

    expect(sendCalls).toEqual([
      {
        text: "first",
        threadTs: "1700000000.2000",
      },
    ]);
    expect(updateCalls).toEqual([
      {
        messageTs: "1700000000.3000",
        text: "first\nsecond",
      },
    ]);

    await history.close();
  });

  it("formats outgoing Slack mentions before sending replies", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const sent: string[] = [];

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      sender: {
        formatOutgoingMentions: async (text) => text.replace("@Alice", "<@U123>"),
        sendMessage: async (_channelId, text) => {
          sent.push(text);
          return {
            messageTs: "1700000000.3000",
          };
        },
      },
      commandHandler: {
        handleIncomingMessage: async (_message, options) => {
          await options.sendResponse?.("@Alice please check this");
          return { response: "ok" };
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      channelName: "#general",
      username: "alice",
      text: "muaddib: ping",
      mynick: "muaddib",
      messageTs: "1700000000.2000",
      channelType: "channel",
      mentionsBot: true,
    });

    expect(sent).toEqual(["<@U123> please check this"]);

    await history.close();
  });

  it("manages Slack typing indicator lifecycle for direct messages", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const typingSetCalls: Array<{ channelId: string; threadTs: string }> = [];
    const typingClearCalls: Array<{ channelId: string; threadTs: string }> = [];

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      sender: {
        setTypingIndicator: async (channelId, threadTs) => {
          typingSetCalls.push({ channelId, threadTs });
          return true;
        },
        clearTypingIndicator: async (channelId, threadTs) => {
          typingClearCalls.push({ channelId, threadTs });
        },
        sendMessage: async () => ({ messageTs: "1700000000.3000" }),
      },
      commandHandler: {
        handleIncomingMessage: async (_message, options) => {
          await options.sendResponse?.("working");
          return { response: "working" };
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      channelName: "#general",
      username: "alice",
      text: "muaddib: run",
      mynick: "muaddib",
      messageTs: "1700000000.2000",
      channelType: "channel",
      mentionsBot: true,
    });

    expect(typingSetCalls).toEqual([
      { channelId: "C123", threadTs: "1700000000.2000" },
      { channelId: "C123", threadTs: "1700000000.2000" },
    ]);
    expect(typingClearCalls).toEqual([{ channelId: "C123", threadTs: "1700000000.2000" }]);

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
      ignoreUsers: ["alice"],
      history,
      commandHandler: {
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

  it("disconnects event source when sender connect fails after startup connect", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let eventSourceConnectCalls = 0;
    let eventSourceDisconnectCalls = 0;
    let senderDisconnectCalls = 0;

    const monitor = new SlackRoomMonitor({
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
        handleIncomingMessage: async () => null,
      },
    });

    await expect(monitor.run()).rejects.toThrow("sender connect failed");
    expect(eventSourceConnectCalls).toBe(1);
    expect(eventSourceDisconnectCalls).toBe(1);
    expect(senderDisconnectCalls).toBe(0);

    await history.close();
  });

  it("reconnects receive loop when event source errors and reconnect policy is enabled", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let connectCalls = 0;
    let disconnectCalls = 0;
    let emittedAfterReconnect = false;
    const processed: string[] = [];

    const monitor = new SlackRoomMonitor({
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
              workspaceId: "T123",
              channelId: "C123",
              username: "alice",
              text: "muaddib: second session",
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
          return null;
        },
      },
    });

    await expect(monitor.run()).resolves.toBeUndefined();
    expect(processed).toEqual(["second session"]);
    expect(connectCalls).toBe(2);
    expect(disconnectCalls).toBe(2);

    await history.close();
  });

  it("stops gracefully on null Slack events even when reconnect is enabled", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let connectCalls = 0;
    let disconnectCalls = 0;

    const monitor = new SlackRoomMonitor({
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
        handleIncomingMessage: async () => null,
      },
    });

    await expect(monitor.run()).resolves.toBeUndefined();
    expect(connectCalls).toBe(1);
    expect(disconnectCalls).toBe(1);

    await history.close();
  });

  it("fails after Slack reconnect max_attempts is exhausted", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let connectCalls = 0;
    let disconnectCalls = 0;

    const monitor = new SlackRoomMonitor({
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
        handleIncomingMessage: async () => null,
      },
    });

    await expect(monitor.run()).rejects.toThrow("socket disconnected");
    expect(connectCalls).toBe(3);
    expect(disconnectCalls).toBe(3);

    await history.close();
  });

  it("does not reconnect Slack monitor when reconnect policy is disabled", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let connectCalls = 0;
    let disconnectCalls = 0;

    const monitor = new SlackRoomMonitor({
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
        handleIncomingMessage: async () => null,
      },
    });

    await expect(monitor.run()).rejects.toThrow("socket disconnected");
    expect(connectCalls).toBe(1);
    expect(disconnectCalls).toBe(1);

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
