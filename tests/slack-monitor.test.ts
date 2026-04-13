import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { buildArc } from "../src/rooms/message.js";
import { SlackRoomMonitor, findArtifactUrls, replaceArtifactUrlsWithUploads, postProcessOutgoingSlackMessage } from "../src/rooms/slack/monitor.js";
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

describe("SlackRoomMonitor", () => {
  it("fromRuntime returns [] when Slack is disabled", async () => {
    const history = createTempHistoryStore(20);

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
    const history = createTempHistoryStore(20);

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
    const history = createTempHistoryStore(20);

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
    const history = createTempHistoryStore(20);

    let seenText = "";
    let isDirect: boolean | undefined = false;

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      sender: {
        sendMessage: async () => {},
      },
      commandHandler: {
        handleIncomingMessage: async (message, options) => {
          seenText = message.content;
          isDirect = message.isDirect;
          await options?.sendResponse?.("ok");
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

  it("sets trusted=true when userId matches Slack allowlist", async () => {
    const history = createTempHistoryStore(20);

    let seenTrusted: boolean | undefined;

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true, userAllowlist: ["alice_U0ABC123"] },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenTrusted = message.trusted;
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      username: "alice",
      userId: "U0ABC123",
      text: "hello",
      mynick: "muaddib",
    });

    expect(seenTrusted).toBe(true);
    await history.close();
  });

  it("sets trusted=false when userId does not match Slack allowlist", async () => {
    const history = createTempHistoryStore(20);

    let seenTrusted: boolean | undefined;

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true, userAllowlist: ["alice_U0ABC123"] },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenTrusted = message.trusted;
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      username: "bob",
      userId: "U0XYZ999",
      text: "hello",
      mynick: "muaddib",
    });

    expect(seenTrusted).toBe(false);
    await history.close();
  });

  it("leaves trusted undefined when no Slack allowlist is configured", async () => {
    const history = createTempHistoryStore(20);

    let seenTrusted: boolean | undefined = true; // sentinel

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenTrusted = message.trusted;
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      username: "alice",
      userId: "U0ABC123",
      text: "hello",
      mynick: "muaddib",
    });

    expect(seenTrusted).toBeUndefined();
    await history.close();
  });

  it("includes Slack attachment context and propagates secrets", async () => {
    const history = createTempHistoryStore(20);

    let seenText = "";
    let seenSecrets: Record<string, unknown> | undefined;

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenText = message.content;
          seenSecrets = message.secrets as Record<string, unknown> | undefined;
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

  it("includes forwarded/shared Slack messages in content", async () => {
    const history = createTempHistoryStore(20);

    let seenText = "";

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenText = message.content;
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      username: "pasky",
      text: "muaddib: make a draft MR",
      mynick: "muaddib",
      mentionsBot: true,
      sharedMessages: [
        {
          authorName: "Jira Cloud",
          text: "PROJ-42 Fix login button alignment\nStatus: Backlog",
          fallback: "[April 3rd] @alice created PROJ-42",
          fromUrl: "https://workspace.slack.com/archives/C0EXAMPLE/p1234",
        },
      ],
    });

    expect(seenText).toContain("make a draft MR");
    expect(seenText).toContain("[Forwarded Messages]");
    expect(seenText).toContain("From: Jira Cloud");
    expect(seenText).toContain("PROJ-42 Fix login button alignment");
    expect(seenText).toContain("Source: https://workspace.slack.com/archives/C0EXAMPLE/p1234");
    expect(seenText).toContain("[/Forwarded Messages]");

    await history.close();
  });

  it("processes shared-message-only events with no text", async () => {
    const history = createTempHistoryStore(20);

    let seenText = "";

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenText = message.content;
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      username: "pasky",
      text: "",
      mynick: "muaddib",
      sharedMessages: [
        {
          authorName: "VaclavRut",
          text: "If the field is required it should say so",
          fallback: "[Mar 31st] VaclavRut: If the field is required",
          fromUrl: "https://workspace.slack.com/archives/C0EXAMPLE/p5678",
        },
      ],
    });

    expect(seenText).toContain("[Forwarded Messages]");
    expect(seenText).toContain("From: VaclavRut");
    expect(seenText).toContain("If the field is required it should say so");
    expect(seenText).toContain("[/Forwarded Messages]");

    await history.close();
  });

  it("normalizes repeated leading mention prefixes using Slack bot id + bot nick", async () => {
    const history = createTempHistoryStore(20);

    let seenText = "";

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenText = message.content;
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
    const history = createTempHistoryStore(20);

    let seenText = "";

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenText = message.content;
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
    const history = createTempHistoryStore(20);

    let seenText = "";

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenText = message.content;
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
    const history = createTempHistoryStore(20);

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
    const history = createTempHistoryStore(20);

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
          await options?.sendResponse?.("ok");
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
    const history = createTempHistoryStore(20);

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
          await options?.sendResponse?.("ok");
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

  it("maps threaded incoming events and passes thread id", async () => {
    const history = createTempHistoryStore(20);

    let seenThreadId: string | undefined;
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
          await options?.sendResponse?.("ok");
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
    expect(sentThreadTs).toBe("1700000000.1111");

    await history.close();
  });

  it("debounces rapid Slack replies by updating the previous bot message", async () => {
    const history = createTempHistoryStore(20);

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
          await options?.sendResponse?.("first");
          await options?.sendResponse?.("second");
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

  it("breaks edit chain when onSteered is called between replies", async () => {
    const history = createTempHistoryStore(20);

    const sendCalls: Array<{ text: string; threadTs?: string }> = [];
    const updateCalls: Array<{ messageTs: string; text: string }> = [];

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true, replyEditDebounceSeconds: 15 },
      history,
      sender: {
        sendMessage: async (_channelId, text, options) => {
          sendCalls.push({ text, threadTs: options?.threadTs });
          return {
            messageTs: `17000000.${sendCalls.length}`,
          };
        },
        updateMessage: async (_channelId, messageTs, text) => {
          updateCalls.push({ messageTs, text });
          return { messageTs };
        },
      },
      commandHandler: {
        handleIncomingMessage: async (_message, options) => {
          // First reply — sent as new message
          await options?.sendResponse?.("first");
          // Simulate a steering message arriving and breaking the edit chain
          options?.onSteered?.();
          // Second reply — should be a NEW message, not an edit
          await options?.sendResponse?.("second");
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

    // Both should be new messages, no edits
    expect(updateCalls).toEqual([]);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]).toEqual({
      text: "first",
      threadTs: "1700000000.2000",
    });
    expect(sendCalls[1]).toEqual({
      text: "second",
      threadTs: "1700000000.2000",
    });

    await history.close();
  });

  it("sends new message when forceNewMessage option is set despite edit debounce window", async () => {
    const history = createTempHistoryStore(20);

    const sendCalls: Array<{ text: string; threadTs?: string }> = [];
    const updateCalls: Array<{ messageTs: string; text: string }> = [];

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true, replyEditDebounceSeconds: 15 },
      history,
      sender: {
        sendMessage: async (_channelId, text, options) => {
          sendCalls.push({ text, threadTs: options?.threadTs });
          return {
            messageTs: `17000000.${sendCalls.length}`,
          };
        },
        updateMessage: async (_channelId, messageTs, text) => {
          updateCalls.push({ messageTs, text });
          return { messageTs };
        },
      },
      commandHandler: {
        handleIncomingMessage: async (_message, options) => {
          await options?.sendResponse?.("first");
          // Second message forces a new message (e.g. network access approval request)
          await options?.sendResponse?.("approval request", { forceNewMessage: true });
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

    // forceNewMessage skips the edit path — both are new messages
    expect(updateCalls).toEqual([]);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0].text).toBe("first");
    expect(sendCalls[1].text).toBe("approval request");

    await history.close();
  });

  it("formats outgoing Slack mentions before sending replies", async () => {
    const history = createTempHistoryStore(20);

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
          await options?.sendResponse?.("@Alice please check this");
          await options?.sendResponse?.("ok");
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

    expect(sent).toEqual(["<@U123> please check this", "ok"]);

    await history.close();
  });

  it("manages Slack typing indicator lifecycle for direct messages", async () => {
    const history = createTempHistoryStore(20);

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
          await options?.sendResponse?.("working");
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
    const history = createTempHistoryStore(20);

    await history.addMessage({
      serverTag: "slack:Rossum",
      channelName: "#general",
      arc: "slack:Rossum##general",
      nick: "Alice",
      mynick: "Muaddib",
      content: "hello",
      platformId: "1700000000.1111",
    });

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: {
        handleIncomingMessage: async () => {},
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

    const arc = buildArc("slack:Rossum", "#general");
    const rows = await history.getFullHistory(arc);
    // Original message at [0], appended edit line at [1]
    expect(rows).toHaveLength(2);
    expect(rows[1].message).toBe("<Alice> edited message");

    await history.close();
  });

  it("ignores users from ignore list through shared command handler", async () => {
    const history = createTempHistoryStore(20);

    let called = false;

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      ignoreUsers: ["alice"],
      history,
      commandHandler: {
        handleIncomingMessage: async () => {
          called = true;
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
    const history = createTempHistoryStore(20);

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
          await options?.sendResponse?.("ok");
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
    const history = createTempHistoryStore(20);

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
          await options?.sendResponse?.("ok");
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
    const history = createTempHistoryStore(20);

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
    const history = createTempHistoryStore(20);

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
        handleIncomingMessage: async () => {},
      },
    });

    await expect(monitor.run()).resolves.toBeUndefined();
    expect(connectCalls).toBe(1);
    expect(disconnectCalls).toBe(1);

    await history.close();
  });

  it("fails after Slack reconnect max_attempts is exhausted", async () => {
    const history = createTempHistoryStore(20);

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
        handleIncomingMessage: async () => {},
      },
    });

    await expect(monitor.run()).rejects.toThrow("socket disconnected");
    expect(connectCalls).toBe(3);
    expect(disconnectCalls).toBe(3);

    await history.close();
  });

  it("does not reconnect Slack monitor when reconnect policy is disabled", async () => {
    const history = createTempHistoryStore(20);

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
        },
      },
    });

    await expect(monitor.run()).resolves.toBeUndefined();
    expect(processed).toEqual(["first", "second"]);
    expect(connectCalls).toBe(1);
    expect(disconnectCalls).toBe(1);

    await history.close();
  });

  it("dequeues later Slack events before earlier handlers finish and waits for in-flight work on shutdown", async () => {
    const history = createTempHistoryStore(20);

    const allowFirstMessageToFinish = createDeferred<void>();
    const firstMessageStarted = createDeferred<void>();
    const startedMessages: string[] = [];
    let receiveEventCalls = 0;
    let runFinished = false;

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      eventSource: {
        receiveEvent: async () => {
          receiveEventCalls += 1;
          if (receiveEventCalls === 1) {
            return {
              workspaceId: "T123",
              channelId: "C123",
              username: "alice",
              text: "muaddib: first",
              mynick: "muaddib",
              mentionsBot: true,
            };
          }

          if (receiveEventCalls === 2) {
            return {
              workspaceId: "T123",
              channelId: "C123",
              username: "alice",
              text: "muaddib: second",
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
});

describe("SlackSocketTransport debug logging", () => {
  it("logs rich Slack payloads that would be dropped because they have no text/files", async () => {
    const { SlackSocketTransport } = await import("../src/rooms/slack/transport.js");
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const transport = new SlackSocketTransport({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workspaceId: "T123",
      logger,
    });

    const result = await (transport as any).mapEvent({
      channel: "C123",
      user: "U123",
      attachments: [{ text: "Forwarded message preview" }],
      blocks: [{ type: "rich_text" }],
    });

    expect(result).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith(
      "Slack message event contains rich payload but no mapped text/files; current mapper will drop it",
      expect.objectContaining({
        channelId: "C123",
        userId: "U123",
        hasText: false,
        fileCount: 0,
        attachmentCount: 1,
        blockCount: 1,
      }),
    );
  });

  it("logs unsupported Slack message subtypes with the raw payload", async () => {
    const { SlackSocketTransport } = await import("../src/rooms/slack/transport.js");
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const transport = new SlackSocketTransport({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workspaceId: "T123",
      logger,
    });

    const result = await (transport as any).mapEvent({
      subtype: "thread_broadcast",
      channel: "C123",
      ts: "1700000000.1234",
      user: "U123",
      text: "Broadcast reply",
    });

    expect(result).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith(
      "Skipping unsupported Slack message subtype",
      expect.objectContaining({
        subtype: "thread_broadcast",
        channelId: "C123",
        messageTs: "1700000000.1234",
        event: expect.objectContaining({
          subtype: "thread_broadcast",
          text: "Broadcast reply",
        }),
      }),
    );
  });
});

describe("SlackSocketTransport shared message extraction", () => {
  it("extracts forwarded/shared message attachments from Slack events", async () => {
    const { SlackSocketTransport } = await import("../src/rooms/slack/transport.js");
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const transport = new SlackSocketTransport({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workspaceId: "T123",
      logger,
    });

    const result = await (transport as any).mapMessage({
      channel: "C123",
      user: "U123",
      text: "make a draft MR",
      channel_type: "channel",
      ts: "1775209937.562219",
      attachments: [
        {
          is_share: true,
          is_msg_unfurl: true,
          author_name: "Jira Cloud",
          text: "PROJ-42 Fix login button alignment",
          fallback: "[April 3rd] @alice created PROJ-42",
          from_url: "https://workspace.slack.com/archives/C0EXAMPLE/p1234",
        },
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.sharedMessages).toHaveLength(1);
    expect(result!.sharedMessages![0]).toEqual({
      authorName: "Jira Cloud",
      text: "PROJ-42 Fix login button alignment",
      fallback: "[April 3rd] @alice created PROJ-42",
      fromUrl: "https://workspace.slack.com/archives/C0EXAMPLE/p1234",
    });
  });

  it("ignores non-shared attachments (link unfurls without is_share)", async () => {
    const { SlackSocketTransport } = await import("../src/rooms/slack/transport.js");
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const transport = new SlackSocketTransport({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workspaceId: "T123",
      logger,
    });

    const result = await (transport as any).mapMessage({
      channel: "C123",
      user: "U123",
      text: "check this out https://example.com",
      channel_type: "channel",
      ts: "1775209937.562219",
      attachments: [
        {
          text: "Example Domain",
          title: "Example",
          title_link: "https://example.com",
        },
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.sharedMessages).toBeUndefined();
  });

  it("maps event with only a shared message and no text to a valid event", async () => {
    const { SlackSocketTransport } = await import("../src/rooms/slack/transport.js");
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const transport = new SlackSocketTransport({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workspaceId: "T123",
      logger,
    });

    const result = await (transport as any).mapMessage({
      channel: "C123",
      user: "U123",
      text: "",
      channel_type: "channel",
      ts: "1775209937.562219",
      attachments: [
        {
          is_share: true,
          author_name: "alice",
          text: "forwarded content",
          from_url: "https://slack.com/archives/C123/p456",
        },
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.sharedMessages).toHaveLength(1);
  });

  it("normalizes Slack entities and user mentions in shared message text", async () => {
    const { SlackSocketTransport } = await import("../src/rooms/slack/transport.js");
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const transport = new SlackSocketTransport({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workspaceId: "T123",
      logger,
    });

    // Pre-populate the user cache so we don't need a real Slack API
    (transport as any).userDisplayNameCache.set("U999", "bob");

    const result = await (transport as any).mapMessage({
      channel: "C123",
      user: "U123",
      text: "check this",
      channel_type: "channel",
      ts: "1775209937.562219",
      attachments: [
        {
          is_share: true,
          author_name: "Jira Cloud",
          text: "<@U999> created a ticket &amp; assigned it",
          fallback: "[April 3rd] <@U999> created PROJ-42",
          from_url: "https://workspace.slack.com/archives/C0EXAMPLE/p1234",
        },
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.sharedMessages).toHaveLength(1);
    expect(result!.sharedMessages![0].text).toBe("@bob created a ticket & assigned it");
    expect(result!.sharedMessages![0].fallback).toBe("[April 3rd] @bob created PROJ-42");
  });
});

describe("SlackSocketTransport.resolveChannelId", () => {
  it("resolves channel name from channelNameCache", async () => {
    // Import the real class and construct a minimal mock
    const { SlackSocketTransport } = await import("../src/rooms/slack/transport.js");
    const transport = Object.create(SlackSocketTransport.prototype) as InstanceType<typeof SlackSocketTransport>;
    (transport as any).channelNameCache = new Map([
      ["C123", "general"],
      ["C456", "random"],
    ]);
    // Ensure getApp won't be called since cache hit should suffice
    (transport as any).app = null;

    const result = await transport.resolveChannelId("general");
    expect(result).toBe("C123");
  });

  it("returns channelName as fallback when not in cache and no app", async () => {
    const { SlackSocketTransport } = await import("../src/rooms/slack/transport.js");
    const transport = Object.create(SlackSocketTransport.prototype) as InstanceType<typeof SlackSocketTransport>;
    (transport as any).channelNameCache = new Map();
    // getApp() will throw "not connected", which resolveChannelId catches
    (transport as any).app = null;

    const result = await transport.resolveChannelId("unknown-channel");
    expect(result).toBe("unknown-channel");
  });
});

describe("findArtifactUrls", () => {
  it("finds artifact viewer URLs in text", () => {
    const text = "Here is your report: https://example.com/artifacts/?aBcD1234.txt and also https://example.com/artifacts/?XyZ789.png";
    const matches = findArtifactUrls(text, "https://example.com/artifacts");
    expect(matches).toEqual([
      { url: "https://example.com/artifacts/?aBcD1234.txt", filename: "aBcD1234.txt" },
      { url: "https://example.com/artifacts/?XyZ789.png", filename: "XyZ789.png" },
    ]);
  });

  it("handles trailing slash in base URL", () => {
    const text = "See: https://example.com/artifacts/?file.md";
    const matches = findArtifactUrls(text, "https://example.com/artifacts/");
    expect(matches).toEqual([
      { url: "https://example.com/artifacts/?file.md", filename: "file.md" },
    ]);
  });

  it("returns empty array when no artifact URLs present", () => {
    const text = "No artifacts here, just https://example.com/other";
    const matches = findArtifactUrls(text, "https://example.com/artifacts");
    expect(matches).toEqual([]);
  });

  it("decodes percent-encoded filenames", () => {
    const text = "See: https://example.com/artifacts/?my%20file.txt";
    const matches = findArtifactUrls(text, "https://example.com/artifacts");
    expect(matches).toEqual([
      { url: "https://example.com/artifacts/?my%20file.txt", filename: "my file.txt" },
    ]);
  });
});

describe("replaceArtifactUrlsWithUploads", () => {
  function makeTempArtifactsDir(): string {
    const dir = join(tmpdir(), `slack-artifact-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("replaces artifact URLs with [attachment N] labels and uploads files with snippet_type", async () => {
    const dir = makeTempArtifactsDir();
    writeFileSync(join(dir, "report.txt"), "full report content");
    writeFileSync(join(dir, "script.py"), "print('hello')");
    writeFileSync(join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const uploaded: Array<{ channelId: string; content: string | Buffer; options: any }> = [];
    const sender = {
      sendMessage: async () => {},
      uploadFile: async (channelId: string, content: string | Buffer, options: any) => {
        uploaded.push({ channelId, content, options });
      },
    };

    const result = await replaceArtifactUrlsWithUploads(
      "Here: https://art.example.com/?report.txt and https://art.example.com/?script.py and https://art.example.com/?image.png done",
      "C123",
      "1700000000.2000",
      { path: dir, url: "https://art.example.com" },
      sender,
    );

    expect(result).toBe("Here: [attachment 1: report.txt] and [attachment 2: script.py] and [attachment 3: image.png] done");
    expect(uploaded).toHaveLength(3);

    // Text file uploaded as string — .txt has no snippet_type mapping
    expect(uploaded[0].channelId).toBe("C123");
    expect(uploaded[0].content).toBe("full report content");
    expect(uploaded[0].options).toEqual({
      filename: "report.txt",
      title: "report.txt",
      threadTs: "1700000000.2000",
      snippetType: undefined,
    });

    // Python file uploaded as string with snippet_type
    expect(uploaded[1].content).toBe("print('hello')");
    expect(uploaded[1].options).toEqual({
      filename: "script.py",
      title: "script.py",
      threadTs: "1700000000.2000",
      snippetType: "python",
    });

    // Binary file uploaded as Buffer — no snippet_type
    expect(uploaded[2].content).toBeInstanceOf(Buffer);
    expect(uploaded[2].options.filename).toBe("image.png");
    expect(uploaded[2].options.snippetType).toBeUndefined();
  });

  it("leaves URL as-is when file does not exist on disk", async () => {
    const dir = makeTempArtifactsDir();
    // No file written

    const sender = {
      sendMessage: async () => {},
      uploadFile: async () => {},
    };

    const result = await replaceArtifactUrlsWithUploads(
      "See: https://art.example.com/?missing.txt",
      "C123",
      undefined,
      { path: dir, url: "https://art.example.com" },
      sender,
    );

    expect(result).toBe("See: https://art.example.com/?missing.txt");
  });

  it("leaves URL as-is when upload fails", async () => {
    const dir = makeTempArtifactsDir();
    writeFileSync(join(dir, "report.txt"), "content");

    const sender = {
      sendMessage: async () => {},
      uploadFile: async () => {
        throw new Error("upload failed");
      },
    };

    const result = await replaceArtifactUrlsWithUploads(
      "See: https://art.example.com/?report.txt",
      "C123",
      undefined,
      { path: dir, url: "https://art.example.com" },
      sender,
    );

    expect(result).toBe("See: https://art.example.com/?report.txt");
  });

  it("returns text unchanged when no artifacts config URL", async () => {
    const sender = {
      sendMessage: async () => {},
      uploadFile: async () => {},
    };

    const result = await replaceArtifactUrlsWithUploads(
      "See: https://art.example.com/?report.txt",
      "C123",
      undefined,
      { path: "/tmp" },
      sender,
    );

    expect(result).toBe("See: https://art.example.com/?report.txt");
  });

  it("returns text unchanged when sender has no uploadFile", async () => {
    const sender = {
      sendMessage: async () => {},
    };

    const result = await replaceArtifactUrlsWithUploads(
      "See: https://art.example.com/?report.txt",
      "C123",
      undefined,
      { path: "/tmp", url: "https://art.example.com" },
      sender,
    );

    expect(result).toBe("See: https://art.example.com/?report.txt");
  });
});

describe("SlackRoomMonitor artifact URL replacement integration", () => {
  it("replaces artifact URLs in outgoing messages with file uploads", async () => {
    const history = createTempHistoryStore(20);
    const dir = join(tmpdir(), `slack-artifact-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "aBcD1234.txt"), "full response text here");

    const uploaded: Array<{ filename: string; content: string | Buffer }> = [];
    const sent: string[] = [];

    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      artifactsConfig: { path: dir, url: "https://art.example.com" },
      sender: {
        sendMessage: async (_channelId, text) => {
          sent.push(text);
          return { messageTs: "1700000000.3000" };
        },
        uploadFile: async (_channelId, content, options) => {
          uploaded.push({ filename: options.filename, content });
        },
      },
      commandHandler: {
        handleIncomingMessage: async (_message, options) => {
          await options?.sendResponse?.(
            "Here is your report... full response: https://art.example.com/?aBcD1234.txt",
          );
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      channelName: "#general",
      username: "alice",
      text: "muaddib: generate report",
      mynick: "muaddib",
      messageTs: "1700000000.2000",
      channelType: "channel",
      mentionsBot: true,
    });

    expect(sent).toEqual([
      "Here is your report... full response: [attachment 1: aBcD1234.txt]",
    ]);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].filename).toBe("aBcD1234.txt");
    expect(uploaded[0].content).toBe("full response text here");

    await history.close();
  });
});

describe("postProcessOutgoingSlackMessage", () => {
  it("applies formatOutgoingMentions and artifact replacement", async () => {
    const dir = join(tmpdir(), `slack-postproc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "aBcD1234.png"), Buffer.from("fake-png"));

    const uploaded: Array<{ filename: string }> = [];
    const sender = {
      sendMessage: async () => {},
      formatOutgoingMentions: async (text: string) => text.replace(/@alice/g, "<@U999>"),
      uploadFile: async (_ch: string, _content: Buffer | string, opts: { filename: string }) => {
        uploaded.push({ filename: opts.filename });
      },
    };

    const result = await postProcessOutgoingSlackMessage(
      "@alice here: https://art.example.com/?aBcD1234.png",
      "C123",
      "1700000000.0000",
      sender,
      { path: dir, url: "https://art.example.com" },
    );

    expect(result).toBe("<@U999> here: [attachment 1: aBcD1234.png]");
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].filename).toBe("aBcD1234.png");
  });

  it("works without formatOutgoingMentions or artifactsConfig", async () => {
    const sender = { sendMessage: async () => {} };
    const result = await postProcessOutgoingSlackMessage("plain text", "C123", undefined, sender, undefined);
    expect(result).toBe("plain text");
  });
});
