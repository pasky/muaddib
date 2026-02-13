import { describe, expect, it } from "vitest";

import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { RoomCommandHandlerTs } from "../src/rooms/command/command-handler.js";
import { DiscordRoomMonitor } from "../src/rooms/discord/monitor.js";
import { SlackRoomMonitor } from "../src/rooms/slack/monitor.js";

function buildRoomConfig() {
  return {
    command: {
      history_size: 40,
      default_mode: "classifier:serious",
      modes: {
        serious: {
          model: "openai:gpt-4o-mini",
          prompt: "You are {mynick}",
          triggers: {
            "!s": {},
          },
        },
      },
      mode_classifier: {
        model: "openai:gpt-4o-mini",
        labels: {
          EASY_SERIOUS: "!s",
        },
        fallback_label: "EASY_SERIOUS",
      },
    },
  };
}

describe("room adapters share RoomCommandHandlerTs behavior", () => {
  it("Discord adapter persists user+assistant via shared handler", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const handler = new RoomCommandHandlerTs({
      roomConfig: buildRoomConfig() as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        prompt: async () => ({
          assistantMessage: {
            role: "assistant",
            content: [{ type: "text", text: "discord-shared" }],
            api: "openai-completions",
            provider: "openai",
            model: "gpt-4o-mini",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          text: "discord-shared",
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      }),
    });

    const sent: string[] = [];
    const monitor = new DiscordRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: handler,
      sender: {
        sendMessage: async (_channel, text) => {
          sent.push(text);
        },
      },
    });

    await monitor.processMessageEvent({
      guildId: "guild-1",
      channelId: "chan-1",
      username: "alice",
      content: "muaddib: hello",
      mynick: "muaddib",
      mentionsBot: true,
    });

    expect(sent).toEqual(["discord-shared"]);

    const historyRows = await history.getFullHistory("discord:guild-1", "chan-1");
    expect(historyRows).toHaveLength(2);
    expect(historyRows[0].role).toBe("user");
    expect(historyRows[1].role).toBe("assistant");

    const context = await history.getContext("discord:guild-1", "chan-1", 10);
    expect(context[1].content).toContain("!s");

    await history.close();
  });

  it("Slack adapter persists user+assistant via shared handler", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const handler = new RoomCommandHandlerTs({
      roomConfig: buildRoomConfig() as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => ({
        prompt: async () => ({
          assistantMessage: {
            role: "assistant",
            content: [{ type: "text", text: "slack-shared" }],
            api: "openai-completions",
            provider: "openai",
            model: "gpt-4o-mini",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          text: "slack-shared",
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      }),
    });

    const sent: string[] = [];
    const monitor = new SlackRoomMonitor({
      roomConfig: { enabled: true },
      history,
      commandHandler: handler,
      sender: {
        sendMessage: async (_channel, text) => {
          sent.push(text);
        },
      },
    });

    await monitor.processMessageEvent({
      workspaceId: "T123",
      channelId: "C123",
      username: "alice",
      text: "muaddib: ping",
      mynick: "muaddib",
      mentionsBot: true,
    });

    expect(sent).toEqual(["slack-shared"]);

    const historyRows = await history.getFullHistory("slack:T123", "C123");
    expect(historyRows).toHaveLength(2);

    const context = await history.getContext("slack:T123", "C123", 10);
    expect(context[1].content).toContain("!s");

    await history.close();
  });
});
