import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { createConfigApiKeyResolver } from "./api-keys.js";
import { assertNoDeferredFeatureConfig } from "./deferred-features.js";
import { RuntimeLogWriter } from "./logging.js";
import { resolveRefusalFallbackModel } from "./refusal-fallback.js";
import { resolvePersistenceSummaryModel } from "./persistence-summary.js";
import { ChronicleStore } from "../chronicle/chronicle-store.js";
import {
  ChronicleLifecycleTs,
  type ChronicleLifecycleConfig,
} from "../chronicle/lifecycle.js";
import { ChatHistoryStore } from "../history/chat-history-store.js";
import { getRoomConfig } from "../rooms/command/config.js";
import { RoomCommandHandlerTs } from "../rooms/command/command-handler.js";
import {
  AutoChroniclerTs,
  type AutoChronicler,
} from "../rooms/autochronicler.js";
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

interface ChroniclerRuntime {
  chronicleStore?: ChronicleStore;
  lifecycle?: ChronicleLifecycleTs;
  autoChronicler?: AutoChronicler;
}

export async function runMuaddibMain(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseAppArgs(argv);
  const runtimeLogger = new RuntimeLogWriter({
    muaddibHome: getMuaddibHome(),
  });
  const logger = runtimeLogger.getLogger("muaddib.app.main");

  logger.info("Starting TypeScript runtime", `config=${args.configPath}`);

  const config = loadConfig(args.configPath);
  assertNoDeferredFeatureConfig(config, logger);

  const historyDbPath = resolveMuaddibPath(
    (config.history as any)?.database?.path,
    join(getMuaddibHome(), "chat_history.db"),
  );

  const ircRoomConfig = getRoomConfig(config, "irc") as any;
  const defaultHistorySize = Number(ircRoomConfig?.command?.history_size ?? 40);

  logger.info("Initializing history storage", `path=${historyDbPath}`, `history_size=${defaultHistorySize}`);

  const history = new ChatHistoryStore(historyDbPath, defaultHistorySize);
  await history.initialize();

  const apiKeyResolver = createConfigApiKeyResolver(config);
  const chroniclerRuntime = await initializeChroniclerRuntime(
    config,
    history,
    apiKeyResolver,
    runtimeLogger,
  );

  try {
    const monitors = createMonitors(config, history, apiKeyResolver, runtimeLogger, chroniclerRuntime);
    if (monitors.length === 0) {
      logger.error("No room monitors enabled.");
      throw new Error("No room monitors enabled.");
    }

    logger.info("Launching room monitors", `count=${monitors.length}`);
    await Promise.all(monitors.map(async (monitor) => await monitor.run()));
  } finally {
    logger.info("Shutting down history storage");
    await history.close();
    await chroniclerRuntime.chronicleStore?.close();
  }
}

function createMonitors(
  config: Record<string, unknown>,
  history: ChatHistoryStore,
  getApiKey: (provider: string) => Promise<string | undefined> | string | undefined,
  runtimeLogger: RuntimeLogWriter,
  chroniclerRuntime: ChroniclerRuntime,
): RunnableMonitor[] {
  const monitors: RunnableMonitor[] = [];
  const logger = runtimeLogger.getLogger("muaddib.app.main");

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
      config,
      chroniclerRuntime,
    );

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
        history,
        commandHandler,
        logger: runtimeLogger.getLogger("muaddib.rooms.irc.monitor"),
      }),
    );
  }

  const discordRoomConfig = getRoomConfig(config, "discord") as any;
  if (isRoomEnabled(discordRoomConfig, false)) {
    const commandHandler = createRoomCommandHandler(
      discordRoomConfig,
      history,
      getApiKey,
      undefined,
      config,
      chroniclerRuntime,
    );
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
        history,
        commandHandler,
        eventSource: transport,
        sender: transport,
        onSendRetryEvent: createSendRetryEventLogger(runtimeLogger.getLogger("muaddib.send-retry.discord")),
        logger: runtimeLogger.getLogger("muaddib.rooms.discord.monitor"),
      }),
    );
  }

  const slackRoomConfig = getRoomConfig(config, "slack") as any;
  if (isRoomEnabled(slackRoomConfig, false)) {
    const commandHandler = createRoomCommandHandler(
      slackRoomConfig,
      history,
      getApiKey,
      undefined,
      config,
      chroniclerRuntime,
    );
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
          history,
          commandHandler,
          eventSource: transport,
          sender: transport,
          onSendRetryEvent: createSendRetryEventLogger(runtimeLogger.getLogger(`muaddib.send-retry.slack.${workspaceId}`)),
          logger: runtimeLogger.getLogger(`muaddib.rooms.slack.monitor.${workspaceId}`),
        }),
      );
    }
  }

  return monitors;
}

async function initializeChroniclerRuntime(
  config: Record<string, unknown>,
  history: ChatHistoryStore,
  getApiKey: (provider: string) => Promise<string | undefined> | string | undefined,
  runtimeLogger: RuntimeLogWriter,
): Promise<ChroniclerRuntime> {
  const logger = runtimeLogger.getLogger("muaddib.app.main");
  const chroniclerConfig = asRecord(config.chronicler);
  const chroniclerModel = stringOrUndefined(chroniclerConfig?.model);

  if (!chroniclerConfig || !chroniclerModel) {
    if (chroniclerConfig && !chroniclerModel) {
      logger.warn("Chronicler config is present without chronicler.model; chronicler runtime disabled.");
    }
    return {};
  }

  const chronicleDbPath = resolveMuaddibPath(
    stringOrUndefined(asRecord(chroniclerConfig.database)?.path),
    join(getMuaddibHome(), "chronicle.db"),
  );

  logger.info("Initializing chronicle storage", `path=${chronicleDbPath}`);

  const chronicleStore = new ChronicleStore(chronicleDbPath);
  await chronicleStore.initialize();

  const lifecycleConfig: ChronicleLifecycleConfig = {
    model: chroniclerModel,
    arc_models: toStringRecord(chroniclerConfig.arc_models),
    paragraphs_per_chapter: numberOrUndefined(chroniclerConfig.paragraphs_per_chapter),
  };

  const lifecycle = new ChronicleLifecycleTs({
    chronicleStore,
    config: lifecycleConfig,
    getApiKey,
  });

  const autoChronicler = new AutoChroniclerTs({
    history,
    chronicleStore,
    lifecycle,
    config: {
      model: chroniclerModel,
      arc_models: toStringRecord(chroniclerConfig.arc_models),
    },
    getApiKey,
    logger: runtimeLogger.getLogger("muaddib.rooms.autochronicler"),
  });

  return {
    chronicleStore,
    lifecycle,
    autoChronicler,
  };
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    const normalized = stringOrUndefined(entry);
    if (!normalized) {
      continue;
    }

    result[key] = normalized;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function createRoomCommandHandler(
  roomConfig: any,
  history: ChatHistoryStore,
  getApiKey: (provider: string) => Promise<string | undefined> | string | undefined,
  responseCleaner?: (text: string, nick: string) => string,
  runtimeConfig?: Record<string, unknown>,
  chroniclerRuntime: ChroniclerRuntime = {},
): RoomCommandHandlerTs {
  const commandConfig = roomConfig?.command ?? {};

  const actorConfig = asRecord(runtimeConfig?.actor);
  const contextReducerConfig = asRecord(runtimeConfig?.context_reducer);
  const toolsConfig = asRecord(runtimeConfig?.tools);
  const artifactsConfig = asRecord(toolsConfig?.artifacts);
  const oracleConfig = asRecord(toolsConfig?.oracle);
  const imageGenConfig = asRecord(toolsConfig?.image_gen);
  const providersConfig = asRecord(runtimeConfig?.providers);
  const openRouterProviderConfig = asRecord(providersConfig?.openrouter);
  const refusalFallbackModel = resolveRefusalFallbackModel(runtimeConfig ?? {});
  const persistenceSummaryModel = resolvePersistenceSummaryModel(runtimeConfig ?? {});

  const maxIterations = numberOrUndefined(actorConfig?.max_iterations);
  const maxCompletionRetries = numberOrUndefined(actorConfig?.max_completion_retries);
  const contextReducerModel = stringOrUndefined(contextReducerConfig?.model);
  const contextReducerPrompt = stringOrUndefined(contextReducerConfig?.prompt);
  const jinaApiKey = stringOrUndefined(asRecord(toolsConfig?.jina)?.api_key);
  const artifactsPathRaw = stringOrUndefined(artifactsConfig?.path);
  const artifactsPath = artifactsPathRaw
    ? resolveMuaddibPath(artifactsPathRaw, join(getMuaddibHome(), "artifacts"))
    : undefined;
  const artifactsUrl = stringOrUndefined(artifactsConfig?.url);
  const oracleModel = stringOrUndefined(oracleConfig?.model);
  const oraclePrompt = stringOrUndefined(oracleConfig?.prompt);
  const imageGenModel = stringOrUndefined(imageGenConfig?.model);
  const openRouterBaseUrl = stringOrUndefined(openRouterProviderConfig?.base_url);

  return new RoomCommandHandlerTs({
    roomConfig,
    history,
    classifyMode: createModeClassifier(commandConfig, { getApiKey }),
    getApiKey,
    responseCleaner,
    refusalFallbackModel,
    persistenceSummaryModel,
    contextReducerConfig: {
      model: contextReducerModel,
      prompt: contextReducerPrompt,
    },
    autoChronicler: chroniclerRuntime.autoChronicler,
    chronicleStore: chroniclerRuntime.chronicleStore,
    agentLoop: {
      maxIterations,
      maxCompletionRetries,
    },
    toolOptions: {
      jinaApiKey,
      artifactsPath,
      artifactsUrl,
      getApiKey,
      oracleModel,
      oraclePrompt,
      imageGenModel,
      openRouterBaseUrl,
      chronicleStore: chroniclerRuntime.chronicleStore,
      chronicleLifecycle: chroniclerRuntime.lifecycle,
    },
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
