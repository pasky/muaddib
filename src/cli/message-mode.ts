import { RuntimeLogWriter } from "../app/logging.js";
import { getMuaddibHome } from "../config/paths.js";
import {
  RoomMessageHandler,
  type CommandRunnerFactory,
} from "../rooms/command/message-handler.js";
import type { RoomMessage } from "../rooms/message.js";
import { createMuaddibRuntime, shutdownRuntime } from "../runtime.js";

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
  const muaddibHome = getMuaddibHome();
  const runtimeLogger = new RuntimeLogWriter({ muaddibHome });

  const roomName = options.roomName ?? "irc";

  const runtime = await createMuaddibRuntime({
    configPath: options.configPath,
    muaddibHome,
    dbPath: options.dbPath ?? ":memory:",
    logger: runtimeLogger,
  });

  try {
    const commandHandler = new RoomMessageHandler(runtime, roomName, {
      runnerFactory: options.runnerFactory,
    });

    const message: RoomMessage = {
      serverTag: options.serverTag ?? "testserver",
      channelName: options.channelName ?? "#testchannel",
      nick: options.nick ?? "testuser",
      mynick: options.mynick ?? "testbot",
      content: options.message,
    };

    const arc = `${message.serverTag}#${message.channelName}`;
    const result = await runtimeLogger.withMessageContext(
      {
        arc,
        nick: message.nick,
        message: message.content,
      },
      async () =>
        await commandHandler.handleIncomingMessage(message, {
          isDirect: true,
        }),
    );

    return {
      response: result?.response ?? null,
      mode: result?.resolved.modeKey ?? null,
      trigger: result?.resolved.selectedTrigger ?? null,
      selectedAutomatically: result?.resolved.selectedAutomatically ?? false,
    };
  } finally {
    await shutdownRuntime(runtime);
  }
}
