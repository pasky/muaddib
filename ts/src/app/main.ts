import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { createConfigApiKeyResolver } from "./api-keys.js";
import { ChatHistoryStore } from "../history/chat-history-store.js";
import { getRoomConfig } from "../rooms/command/config.js";
import { RoomCommandHandlerTs } from "../rooms/command/command-handler.js";
import { createModeClassifier } from "../rooms/command/classifier.js";
import { DiscordRoomMonitor } from "../rooms/discord/monitor.js";
import { DiscordGatewayTransport } from "../rooms/discord/transport.js";
import { IrcRoomMonitor } from "../rooms/irc/monitor.js";
import { SlackRoomMonitor } from "../rooms/slack/monitor.js";
import { SlackSocketTransport } from "../rooms/slack/transport.js";
import {
  getMuaddibHome,
  loadConfig,
  parseAppArgs,
  resolveMuaddibPath,
} from "./bootstrap.js";

interface RunnableMonitor {
  run(): Promise<void>;
}

export async function runMuaddibMain(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseAppArgs(argv);
  const config = loadConfig(args.configPath);

  const historyDbPath = resolveMuaddibPath(
    (config.history as any)?.database?.path,
    join(getMuaddibHome(), "chat_history.db"),
  );

  const ircRoomConfig = getRoomConfig(config, "irc") as any;
  const defaultHistorySize = Number(ircRoomConfig?.command?.history_size ?? 40);

  const history = new ChatHistoryStore(historyDbPath, defaultHistorySize);
  await history.initialize();

  const apiKeyResolver = createConfigApiKeyResolver(config);

  try {
    const monitors = createMonitors(config, history, apiKeyResolver);
    if (monitors.length === 0) {
      throw new Error("No room monitors enabled.");
    }

    await Promise.all(monitors.map(async (monitor) => await monitor.run()));
  } finally {
    await history.close();
  }
}

function createMonitors(
  config: Record<string, unknown>,
  history: ChatHistoryStore,
  getApiKey: (provider: string) => Promise<string | undefined> | string | undefined,
): RunnableMonitor[] {
  const monitors: RunnableMonitor[] = [];

  const ircRoomConfig = getRoomConfig(config, "irc") as any;
  if (isRoomEnabled(ircRoomConfig, true) && ircRoomConfig?.varlink) {
    const commandHandler = createRoomCommandHandler(
      ircRoomConfig,
      history,
      getApiKey,
      (text) => text.replace(/\n/g, "; ").trim(),
    );

    monitors.push(
      new IrcRoomMonitor({
        roomConfig: ircRoomConfig,
        history,
        commandHandler,
      }),
    );
  }

  const discordRoomConfig = getRoomConfig(config, "discord") as any;
  if (isRoomEnabled(discordRoomConfig, false)) {
    const commandHandler = createRoomCommandHandler(discordRoomConfig, history, getApiKey);
    const discordToken = discordRoomConfig?.token;
    const transport =
      typeof discordToken === "string" && discordToken
        ? new DiscordGatewayTransport({
            token: discordToken,
            botNameFallback: discordRoomConfig?.bot_name,
          })
        : undefined;

    monitors.push(
      new DiscordRoomMonitor({
        roomConfig: discordRoomConfig,
        history,
        commandHandler,
        eventSource: transport,
        sender: transport,
      }),
    );
  }

  const slackRoomConfig = getRoomConfig(config, "slack") as any;
  if (isRoomEnabled(slackRoomConfig, false)) {
    const commandHandler = createRoomCommandHandler(slackRoomConfig, history, getApiKey);
    const slackAppToken = slackRoomConfig?.app_token;

    if (typeof slackAppToken === "string" && slackAppToken) {
      const workspaces = (slackRoomConfig?.workspaces as Record<string, any> | undefined) ?? {};
      for (const [workspaceId, workspaceConfig] of Object.entries(workspaces)) {
        const botToken = workspaceConfig?.bot_token;
        if (typeof botToken !== "string" || !botToken) {
          continue;
        }

        const transport = new SlackSocketTransport({
          appToken: slackAppToken,
          botToken,
          workspaceId,
          botNameFallback: workspaceConfig?.name,
        });

        monitors.push(
          new SlackRoomMonitor({
            roomConfig: slackRoomConfig,
            history,
            commandHandler,
            eventSource: transport,
            sender: transport,
          }),
        );
      }
    } else {
      monitors.push(
        new SlackRoomMonitor({
          roomConfig: slackRoomConfig,
          history,
          commandHandler,
        }),
      );
    }
  }

  return monitors;
}

function createRoomCommandHandler(
  roomConfig: any,
  history: ChatHistoryStore,
  getApiKey: (provider: string) => Promise<string | undefined> | string | undefined,
  responseCleaner?: (text: string, nick: string) => string,
): RoomCommandHandlerTs {
  const commandConfig = roomConfig?.command ?? {};

  return new RoomCommandHandlerTs({
    roomConfig,
    history,
    classifyMode: createModeClassifier(commandConfig, { getApiKey }),
    getApiKey,
    responseCleaner,
  });
}

function isRoomEnabled(roomConfig: any, defaultValue: boolean): boolean {
  if (typeof roomConfig?.enabled === "boolean") {
    return roomConfig.enabled;
  }
  return defaultValue;
}

if (isExecutedAsMain()) {
  await runMuaddibMain();
}

function isExecutedAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}
