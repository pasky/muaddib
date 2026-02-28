#!/usr/bin/env node
// Prevent Node.js inspector from activating on SIGUSR1, which would bind a
// debugger to 127.0.0.1 accessible to any local process (including the agent).
process.on("SIGUSR1", () => {});

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { RuntimeLogWriter } from "./logging.js";
import { DiscordRoomMonitor } from "../rooms/discord/monitor.js";
import { IrcRoomMonitor } from "../rooms/irc/monitor.js";
import { SlackRoomMonitor } from "../rooms/slack/monitor.js";
import { RoomGateway } from "../rooms/room-gateway.js";
import { ArcEventsWatcher } from "../events/watcher.js";
import { getMuaddibHome } from "../config/paths.js";
import { createMuaddibRuntime, shutdownRuntime, type MuaddibRuntime } from "../runtime.js";

interface AppArgs {
  configPath: string;
}

function parseAppArgs(argv: string[] = process.argv.slice(2)): AppArgs {
  let configPath = join(getMuaddibHome(), "config.json");

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--config" && argv[i + 1]) {
      configPath = argv[i + 1];
      i += 1;
    }
  }

  return { configPath };
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

  const gateway = new RoomGateway();
  const eventsConfig = runtime.config.getEventsConfig();
  const eventsWatcher = new ArcEventsWatcher(gateway, logger, {
    heartbeatIntervalMs: eventsConfig.heartbeatIntervalMinutes * 60 * 1000,
    minPeriodMs: eventsConfig.minPeriodMinutes * 60 * 1000,
  });

  try {
    const monitors = await createMonitors(runtime, gateway, eventsWatcher);
    if (monitors.length === 0) {
      logger.error("No room monitors enabled.");
      throw new Error("No room monitors enabled.");
    }

    eventsWatcher.start();
    logger.info("Launching room monitors", `count=${monitors.length}`);
    await Promise.all(monitors.map(async (monitor) => await monitor.run()));
  } finally {
    eventsWatcher.stop();
    logger.info("Shutting down history storage");
    await shutdownRuntime(runtime);
  }
}

async function createMonitors(
  runtime: MuaddibRuntime,
  gateway: RoomGateway,
  eventsWatcher: ArcEventsWatcher,
): Promise<Array<{ run(): Promise<void> }>> {
  const opts = { gateway, eventsWatcher };
  const monitors: Array<{ run(): Promise<void> }> = [];
  monitors.push(...IrcRoomMonitor.fromRuntime(runtime, opts));
  monitors.push(...await DiscordRoomMonitor.fromRuntime(runtime, opts));
  monitors.push(...await SlackRoomMonitor.fromRuntime(runtime, opts));
  return monitors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMuaddibMain();
}
