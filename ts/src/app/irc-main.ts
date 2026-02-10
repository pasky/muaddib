import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ChatHistoryStore } from "../history/chat-history-store.js";
import { getRoomConfig } from "../rooms/command/config.js";
import { RoomCommandHandlerTs } from "../rooms/command/command-handler.js";
import { IrcRoomMonitor } from "../rooms/irc/monitor.js";

interface ParsedArgs {
  configPath: string;
}

export async function runIrcMain(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const config = loadConfig(args.configPath);

  const ircRoomConfig = getRoomConfig(config, "irc") as any;
  const commandConfig = ircRoomConfig.command;

  if (!commandConfig) {
    throw new Error("rooms.irc.command configuration missing");
  }

  const historyDbPath = resolvePath(
    (config.history as any)?.database?.path,
    join(getMuaddibHome(), "chat_history.db"),
  );

  const history = new ChatHistoryStore(historyDbPath, Number(commandConfig.history_size ?? 40));
  await history.initialize();

  const fallbackLabel =
    commandConfig.mode_classifier?.fallback_label ??
    Object.keys(commandConfig.mode_classifier?.labels ?? {})[0];

  const commandHandler = new RoomCommandHandlerTs({
    roomConfig: ircRoomConfig,
    history,
    classifyMode: async () => fallbackLabel,
    responseCleaner: (text) => text.replace(/\n/g, "; ").trim(),
  });

  const monitor = new IrcRoomMonitor({
    roomConfig: ircRoomConfig,
    history,
    commandHandler,
  });

  try {
    await monitor.run();
  } finally {
    await history.close();
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  let configPath = join(getMuaddibHome(), "config.json");

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--config" && argv[i + 1]) {
      configPath = argv[i + 1];
      i += 1;
    }
  }

  return { configPath };
}

function loadConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}`);
  }

  return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
}

function resolvePath(path: string | undefined, fallback: string): string {
  if (!path) {
    return fallback;
  }

  if (path.startsWith("/")) {
    return path;
  }

  return join(getMuaddibHome(), path);
}

function getMuaddibHome(): string {
  return process.env.MUADDIB_HOME ?? join(homedir(), ".muaddib");
}
