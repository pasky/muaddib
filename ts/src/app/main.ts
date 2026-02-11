import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { createConfigApiKeyResolver } from "./api-keys.js";
import { assertNoDeferredFeatureConfig } from "./deferred-features.js";
import { ChatHistoryStore } from "../history/chat-history-store.js";
import { getRoomConfig } from "../rooms/command/config.js";
import { RoomCommandHandlerTs } from "../rooms/command/command-handler.js";
import { createModeClassifier } from "../rooms/command/classifier.js";
import { DiscordRoomMonitor } from "../rooms/discord/monitor.js";
import { DiscordGatewayTransport } from "../rooms/discord/transport.js";
import { IrcRoomMonitor } from "../rooms/irc/monitor.js";
import { SlackRoomMonitor } from "../rooms/slack/monitor.js";
import { SlackSocketTransport } from "../rooms/slack/transport.js";
import type { SendRetryEvent } from "../rooms/send-retry.js";
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
  assertNoDeferredFeatureConfig(config);

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
  if (isRoomEnabled(ircRoomConfig, true)) {
    const socketPath = requireNonEmptyString(
      ircRoomConfig?.varlink?.socket_path,
      "IRC room is enabled but rooms.irc.varlink.socket_path is missing.",
    );

    const commandHandler = createRoomCommandHandler(
      ircRoomConfig,
      history,
      getApiKey,
      (text) => text.replace(/\n/g, "; ").trim(),
    );

    monitors.push(
      new IrcRoomMonitor({
        roomConfig: {
          ...ircRoomConfig,
          varlink: {
            ...(ircRoomConfig?.varlink ?? {}),
            socket_path: socketPath,
          },
        },
        history,
        commandHandler,
      }),
    );
  }

  const discordRoomConfig = getRoomConfig(config, "discord") as any;
  if (isRoomEnabled(discordRoomConfig, false)) {
    const commandHandler = createRoomCommandHandler(discordRoomConfig, history, getApiKey);
    const discordToken = requireNonEmptyString(
      discordRoomConfig?.token,
      "Discord room is enabled but rooms.discord.token is missing.",
    );

    const transport = new DiscordGatewayTransport({
      token: discordToken,
      botNameFallback: discordRoomConfig?.bot_name,
    });

    monitors.push(
      new DiscordRoomMonitor({
        roomConfig: discordRoomConfig,
        history,
        commandHandler,
        eventSource: transport,
        sender: transport,
        onSendRetryEvent: createSendRetryEventLogger(),
      }),
    );
  }

  const slackRoomConfig = getRoomConfig(config, "slack") as any;
  if (isRoomEnabled(slackRoomConfig, false)) {
    const commandHandler = createRoomCommandHandler(slackRoomConfig, history, getApiKey);
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

      monitors.push(
        new SlackRoomMonitor({
          roomConfig: slackRoomConfig,
          history,
          commandHandler,
          eventSource: transport,
          sender: transport,
          onSendRetryEvent: createSendRetryEventLogger(),
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
