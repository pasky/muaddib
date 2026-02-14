import { pathToFileURL } from "node:url";

import { RuntimeLogWriter, type RuntimeLogger } from "./logging.js";
import { RoomCommandHandlerTs } from "../rooms/command/command-handler.js";
import { DiscordRoomMonitor } from "../rooms/discord/monitor.js";
import { DiscordGatewayTransport } from "../rooms/discord/transport.js";
import { IrcRoomMonitor } from "../rooms/irc/monitor.js";
import { SlackRoomMonitor } from "../rooms/slack/monitor.js";
import { SlackSocketTransport } from "../rooms/slack/transport.js";
import type { SendRetryEvent } from "../rooms/send-retry.js";
import { getMuaddibHome, parseAppArgs } from "./bootstrap.js";
import { createMuaddibRuntime, shutdownRuntime, type MuaddibRuntime } from "../runtime.js";

interface RunnableMonitor {
  run(): Promise<void>;
}

export async function runMuaddibMain(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseAppArgs(argv);
  const runtimeLogger = new RuntimeLogWriter({
    muaddibHome: getMuaddibHome(),
  });
  const logger = runtimeLogger.getLogger("muaddib.app.main");

  logger.info("Starting TypeScript runtime", `config=${args.configPath}`);

  const runtime = await createMuaddibRuntime({
    configPath: args.configPath,
    logger: runtimeLogger,
  });

  try {
    const monitors = createMonitors(runtime);
    if (monitors.length === 0) {
      logger.error("No room monitors enabled.");
      throw new Error("No room monitors enabled.");
    }

    logger.info("Launching room monitors", `count=${monitors.length}`);
    await Promise.all(monitors.map(async (monitor) => await monitor.run()));
  } finally {
    logger.info("Shutting down history storage");
    await shutdownRuntime(runtime);
  }
}

function createMonitors(runtime: MuaddibRuntime): RunnableMonitor[] {
  const monitors: RunnableMonitor[] = [];
  const logger = runtime.logger.getLogger("muaddib.app.main");

  // IRC
  const ircRoomConfig = runtime.config.getRoomConfig("irc") as any;
  if (isRoomEnabled(ircRoomConfig, true)) {
    const socketPath = requireNonEmptyString(
      ircRoomConfig?.varlink?.socket_path,
      "IRC room is enabled but rooms.irc.varlink.socket_path is missing.",
    );

    const commandHandler = RoomCommandHandlerTs.fromRuntime(runtime, "irc", {
      responseCleaner: (text) => text.replace(/\n/g, "; ").trim(),
    });

    logger.info("Enabling IRC room monitor", `socket_path=${socketPath}`);
    monitors.push(
      new IrcRoomMonitor({
        roomConfig: {
          ...ircRoomConfig,
          varlink: {
            ...(ircRoomConfig?.varlink ?? {}),
            socket_path: socketPath,
          },
        },
        history: runtime.history,
        commandHandler,
        logger: runtime.logger.getLogger("muaddib.rooms.irc.monitor"),
      }),
    );
  }

  // Discord
  const discordRoomConfig = runtime.config.getRoomConfig("discord") as any;
  if (isRoomEnabled(discordRoomConfig, false)) {
    const commandHandler = RoomCommandHandlerTs.fromRuntime(runtime, "discord");
    const discordToken = requireNonEmptyString(
      discordRoomConfig?.token,
      "Discord room is enabled but rooms.discord.token is missing.",
    );

    const transport = new DiscordGatewayTransport({
      token: discordToken,
      botNameFallback: discordRoomConfig?.bot_name,
    });

    logger.info("Enabling Discord room monitor");
    monitors.push(
      new DiscordRoomMonitor({
        roomConfig: discordRoomConfig,
        history: runtime.history,
        commandHandler,
        eventSource: transport,
        sender: transport,
        onSendRetryEvent: createSendRetryEventLogger(runtime.logger.getLogger("muaddib.send-retry.discord")),
        logger: runtime.logger.getLogger("muaddib.rooms.discord.monitor"),
      }),
    );
  }

  // Slack
  const slackRoomConfig = runtime.config.getRoomConfig("slack") as any;
  if (isRoomEnabled(slackRoomConfig, false)) {
    const commandHandler = RoomCommandHandlerTs.fromRuntime(runtime, "slack");
    const slackAppToken = requireNonEmptyString(
      slackRoomConfig?.app_token,
      "Slack room is enabled but rooms.slack.app_token is missing.",
    );

    const workspaces = (slackRoomConfig?.workspaces as Record<string, any> | undefined) ?? {};
    const workspaceEntries = Object.entries(workspaces);
    if (workspaceEntries.length === 0) {
      throw new Error("Slack room is enabled but rooms.slack.workspaces is missing.");
    }

    for (const [workspaceId, workspaceConfig] of workspaceEntries) {
      const botToken = requireNonEmptyString(
        workspaceConfig?.bot_token,
        `Slack room is enabled but rooms.slack.workspaces.${workspaceId}.bot_token is missing.`,
      );

      const transport = new SlackSocketTransport({
        appToken: slackAppToken,
        botToken,
        workspaceId,
        workspaceName: workspaceConfig?.name,
        botNameFallback: workspaceConfig?.name,
      });

      logger.info("Enabling Slack room monitor", `workspace=${workspaceId}`);
      monitors.push(
        new SlackRoomMonitor({
          roomConfig: slackRoomConfig,
          history: runtime.history,
          commandHandler,
          eventSource: transport,
          sender: transport,
          onSendRetryEvent: createSendRetryEventLogger(runtime.logger.getLogger(`muaddib.send-retry.slack.${workspaceId}`)),
          logger: runtime.logger.getLogger(`muaddib.rooms.slack.monitor.${workspaceId}`),
        }),
      );
    }
  }

  return monitors;
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}

function isRoomEnabled(roomConfig: any, defaultValue: boolean): boolean {
  if (typeof roomConfig?.enabled === "boolean") {
    return roomConfig.enabled;
  }
  return defaultValue;
}

interface SendRetryLogger {
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
}

export function createSendRetryEventLogger(logger: SendRetryLogger = console): (event: SendRetryEvent) => void {
  return (event: SendRetryEvent): void => {
    const payload = {
      event: "send_retry",
      type: event.type,
      retryable: event.retryable,
      platform: event.platform,
      destination: event.destination,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      retryAfterMs: event.retryAfterMs,
      error: summarizeRetryError(event.error),
    };

    const serialized = JSON.stringify(payload);

    if (event.type === "retry") {
      logger.warn("[muaddib][send-retry]", serialized);
    } else {
      logger.error("[muaddib][send-retry]", serialized);
    }

    logger.info("[muaddib][metric]", serialized);
  };
}

function summarizeRetryError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const extra = error as Error & {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };

    return {
      name: error.name,
      message: error.message,
      code: extra.code,
      status: extra.status,
      statusCode: extra.statusCode,
    };
  }

  if (typeof error === "object" && error !== null) {
    return error as Record<string, unknown>;
  }

  return {
    value: String(error),
  };
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
