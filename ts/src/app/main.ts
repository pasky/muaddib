import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { ChatHistoryStore } from "../history/chat-history-store.js";
import { getRoomConfig } from "../rooms/command/config.js";
import { RoomCommandHandlerTs } from "../rooms/command/command-handler.js";
import { DiscordRoomMonitor } from "../rooms/discord/monitor.js";
import { IrcRoomMonitor } from "../rooms/irc/monitor.js";
import { SlackRoomMonitor } from "../rooms/slack/monitor.js";
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

  try {
    const monitors = createMonitors(config, history);
    if (monitors.length === 0) {
      throw new Error("No room monitors enabled.");
    }

    await Promise.all(monitors.map(async (monitor) => await monitor.run()));
  } finally {
    await history.close();
  }
}

function createMonitors(config: Record<string, unknown>, history: ChatHistoryStore): RunnableMonitor[] {
  const monitors: RunnableMonitor[] = [];

  const ircRoomConfig = getRoomConfig(config, "irc") as any;
  if (isRoomEnabled(ircRoomConfig, true) && ircRoomConfig?.varlink) {
    const commandHandler = createRoomCommandHandler(ircRoomConfig, history, (text) =>
      text.replace(/\n/g, "; ").trim(),
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
    const commandHandler = createRoomCommandHandler(discordRoomConfig, history);
    monitors.push(
      new DiscordRoomMonitor({
        roomConfig: discordRoomConfig,
        history,
        commandHandler,
      }),
    );
  }

  const slackRoomConfig = getRoomConfig(config, "slack") as any;
  if (isRoomEnabled(slackRoomConfig, false)) {
    const commandHandler = createRoomCommandHandler(slackRoomConfig, history);
    monitors.push(
      new SlackRoomMonitor({
        roomConfig: slackRoomConfig,
        history,
        commandHandler,
      }),
    );
  }

  return monitors;
}

function createRoomCommandHandler(
  roomConfig: any,
  history: ChatHistoryStore,
  responseCleaner?: (text: string, nick: string) => string,
): RoomCommandHandlerTs {
  const commandConfig = roomConfig?.command ?? {};
  const fallbackLabel =
    commandConfig.mode_classifier?.fallback_label ??
    Object.keys(commandConfig.mode_classifier?.labels ?? {})[0];

  return new RoomCommandHandlerTs({
    roomConfig,
    history,
    classifyMode: async () => fallbackLabel,
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
