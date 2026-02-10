import { runCliMessageMode } from "./message-mode.js";

interface ParsedArgs {
  message: string;
  configPath: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let message = "";
  let configPath = "./config.json";
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
  }

  return { message, configPath, help };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.message) {
    // eslint-disable-next-line no-console
    console.log("Usage: node dist/cli/main.js --message \"...\" [--config /path/to/config.json]");
    if (!args.help && !args.message) {
      process.exitCode = 2;
    }
    return;
  }

  const result = await runCliMessageMode({
    message: args.message,
    configPath: args.configPath,
  });

  if (result.response) {
    // eslint-disable-next-line no-console
    console.log(result.response);
  }
}

await main();
