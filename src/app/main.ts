import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { RuntimeLogWriter } from "./logging.js";
import { DiscordRoomMonitor } from "../rooms/discord/monitor.js";
import { IrcRoomMonitor } from "../rooms/irc/monitor.js";
import { SlackRoomMonitor } from "../rooms/slack/monitor.js";
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

  try {
    const monitors = await createMonitors(runtime);
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

async function createMonitors(runtime: MuaddibRuntime): Promise<Array<{ run(): Promise<void> }>> {
  const monitors: Array<{ run(): Promise<void> }> = [];
  monitors.push(...IrcRoomMonitor.fromRuntime(runtime));
  monitors.push(...await DiscordRoomMonitor.fromRuntime(runtime));
  monitors.push(...await SlackRoomMonitor.fromRuntime(runtime));
  return monitors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMuaddibMain();
}
