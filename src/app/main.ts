import { pathToFileURL } from "node:url";

import { RuntimeLogWriter } from "./logging.js";
import { DiscordRoomMonitor } from "../rooms/discord/monitor.js";
import { IrcRoomMonitor } from "../rooms/irc/monitor.js";
import { SlackRoomMonitor } from "../rooms/slack/monitor.js";
import { createSendRetryEventLogger } from "../rooms/send-retry.js";
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
