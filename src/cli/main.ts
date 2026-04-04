#!/usr/bin/env node
// Prevent Node.js inspector from activating on SIGUSR1, which would bind a
// debugger to 127.0.0.1 accessible to any local process (including the agent).
process.on("SIGUSR1", () => {});

import { runCliMessageMode } from "./message-mode.js";

interface ParsedArgs {
  message: string;
  configPath: string;
  roomName?: string;
  arcsPath?: string;
  arcs: string[];
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let message = "";
  let configPath = "./config.json";
  let roomName: string | undefined;
  let arcsPath: string | undefined;
  const arcs: string[] = [];
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--message" && argv[i + 1]) {
      message = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--config" && argv[i + 1]) {
      configPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--room" && argv[i + 1]) {
      roomName = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--arcs-path" && argv[i + 1]) {
      arcsPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--arc" && argv[i + 1]) {
      arcs.push(argv[i + 1]);
      i += 1;
      continue;
    }
  }

  return { message, configPath, roomName, arcsPath, arcs, help };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.message) {
    // eslint-disable-next-line no-console
    console.log(
      "Usage: node dist/cli/main.js --message \"...\" [--config /path/to/config.json] [--room irc|discord|slack] [--arcs-path /path/to/arcs] [--arc <arc-name> ...]",
    );
    if (!args.help && !args.message) {
      process.exitCode = 2;
    }
    return;
  }

  const arcs = args.arcs.length > 0 ? args.arcs : [undefined];
  for (const arc of arcs) {
    if (arc) {
      // eslint-disable-next-line no-console
      console.log(`\n=== Arc: ${arc} ===`);
    }
    const result = await runCliMessageMode({
      message: args.message,
      configPath: args.configPath,
      roomName: args.roomName,
      arcsPath: args.arcsPath,
      arc,
    });

    if (result.response) {
      // eslint-disable-next-line no-console
      console.log(result.response);
    }
  }
}

await main();
