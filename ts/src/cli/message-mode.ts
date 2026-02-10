import { readFileSync } from "node:fs";

import { createConfigApiKeyResolver } from "../app/api-keys.js";
import { MuaddibAgentRunner } from "../agent/muaddib-agent-runner.js";
import { ChatHistoryStore } from "../history/chat-history-store.js";
import { createModeClassifier } from "../rooms/command/classifier.js";
import { getRoomConfig } from "../rooms/command/config.js";
import {
  RoomCommandHandlerTs,
  type CommandRunnerFactory,
} from "../rooms/command/command-handler.js";
import type { RoomMessage } from "../rooms/message.js";

export interface CliMessageModeOptions {
  message: string;
  configPath: string;
  roomName?: string;
  serverTag?: string;
  channelName?: string;
  nick?: string;
  mynick?: string;
  dbPath?: string;
  runnerFactory?: CommandRunnerFactory;
}

export interface CliMessageModeResult {
  response: string | null;
  mode: string | null;
  trigger: string | null;
  selectedAutomatically: boolean;
}

/**
 * Basic CLI parity path for TS migration:
 * command parse -> context load -> runner call -> response formatting.
 */
export async function runCliMessageMode(options: CliMessageModeOptions): Promise<CliMessageModeResult> {
  const config = JSON.parse(readFileSync(options.configPath, "utf-8")) as Record<string, unknown>;
  const roomName = options.roomName ?? "irc";
  const roomConfig = getRoomConfig(config, roomName) as any;
  const commandConfig = roomConfig.command;
  const getApiKey = createConfigApiKeyResolver(config);

  if (!commandConfig) {
    throw new Error(`Room '${roomName}' does not define command config.`);
  }

  const history = new ChatHistoryStore(options.dbPath ?? ":memory:", commandConfig.history_size ?? 40);
  await history.initialize();

  const message: RoomMessage = {
    serverTag: options.serverTag ?? "testserver",
    channelName: options.channelName ?? "#testchannel",
    nick: options.nick ?? "testuser",
    mynick: options.mynick ?? "testbot",
    content: options.message,
  };

  const defaultRunnerFactory: CommandRunnerFactory = (input) =>
    new MuaddibAgentRunner({
      model: input.model,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      getApiKey,
    });

  const commandHandler = new RoomCommandHandlerTs({
    roomConfig,
    history,
    classifyMode: createModeClassifier(commandConfig, { getApiKey }),
    getApiKey,
    runnerFactory: options.runnerFactory ?? defaultRunnerFactory,
  });

  const result = await commandHandler.handleIncomingMessage(message, {
    isDirect: true,
  });
  await history.close();

  return {
    response: result?.response ?? null,
    mode: result?.resolved.modeKey ?? null,
    trigger: result?.resolved.selectedTrigger ?? null,
    selectedAutomatically: result?.resolved.selectedAutomatically ?? false,
  };
}
