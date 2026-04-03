import { RuntimeLogWriter } from "../app/logging.js";
import { getMuaddibHome } from "../config/paths.js";
import {
  RoomMessageHandler,
  type CommandRunnerFactory,
} from "../rooms/command/message-handler.js";
import { type RoomMessage, buildArc } from "../rooms/message.js";
import { createMuaddibRuntime, shutdownRuntime } from "../runtime.js";
import type { NetworkAccessApprover } from "../agent/network-boundary.js";
import { parseArc } from "../rooms/room-gateway.js";

export interface CliMessageModeOptions {
  message: string;
  configPath: string;
  roomName?: string;
  serverTag?: string;
  channelName?: string;
  nick?: string;
  mynick?: string;
  arcsPath?: string;
  /** Target arc name (e.g. "libera##foo"). Derives serverTag, channelName, and roomName. */
  arc?: string;
  runnerFactory?: CommandRunnerFactory;
  networkAccessApprover?: NetworkAccessApprover;
}

export interface CliMessageModeResult {
  response: string | null;
}

/**
 * Basic CLI parity path for TS migration:
 * command parse -> context load -> runner call -> response formatting.
 */
export async function runCliMessageMode(options: CliMessageModeOptions): Promise<CliMessageModeResult> {
  const muaddibHome = getMuaddibHome();
  const runtimeLogger = new RuntimeLogWriter({ muaddibHome });

  // When --arc is given, derive serverTag/channelName/roomName from it.
  let serverTag = options.serverTag;
  let channelName = options.channelName;
  let roomName = options.roomName;
  if (options.arc) {
    const parsed = parseArc(options.arc);
    serverTag ??= parsed.serverTag;
    channelName ??= parsed.channelName;
    if (!roomName) {
      if (parsed.serverTag.startsWith("discord:")) roomName = "discord";
      else if (parsed.serverTag.startsWith("slack:")) roomName = "slack";
      else roomName = "irc";
    }
  }
  serverTag ??= "testserver";
  channelName ??= "#testchannel";
  roomName ??= "irc";

  const runtime = await createMuaddibRuntime({
    configPath: options.configPath,
    muaddibHome,
    arcsPath: options.arcsPath,
    logger: runtimeLogger,
    networkAccessApprover: options.networkAccessApprover ?? (async () => {
      throw new Error(
        "request_network_access in CLI mode requires a harness-provided networkAccessApprover or a matching agent.tools.gondolin urlAllowRegexes rule.",
      );
    }),
  });

  try {
    const commandHandler = new RoomMessageHandler(runtime, roomName, {
      runnerFactory: options.runnerFactory,
    });

    const message: RoomMessage = {
      serverTag,
      channelName,
      arc: buildArc(serverTag, channelName),
      nick: options.nick ?? "testuser",
      mynick: options.mynick ?? "testbot",
      content: options.message,
      isDirect: true,
    };

    const arc = message.arc;
    const responses: string[] = [];
    const sendResponse = async (text: string) => { responses.push(text); };

    await runtimeLogger.withMessageContext(
      {
        arc,
        nick: message.nick,
        message: message.content,
      },
      async () =>
        await commandHandler.handleIncomingMessage(message, { sendResponse }),
    );

    return {
      response: responses.length > 0 ? responses[responses.length - 1] : null,
    };
  } finally {
    await shutdownRuntime(runtime);
  }
}
