import { pathToFileURL } from "node:url";

import { RuntimeLogWriter } from "./logging.js";
import { DiscordRoomMonitor } from "../rooms/discord/monitor.js";
import { IrcRoomMonitor } from "../rooms/irc/monitor.js";
import { SlackRoomMonitor } from "../rooms/slack/monitor.js";
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
  // IRC
  monitors.push(...IrcRoomMonitor.fromRuntime(runtime));

  // Discord
  monitors.push(...DiscordRoomMonitor.fromRuntime(runtime));

  // Slack
  monitors.push(...SlackRoomMonitor.fromRuntime(runtime));

  return monitors;
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
