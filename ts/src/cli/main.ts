import { runCliMessageMode } from "./message-mode.js";

interface ParsedArgs {
  message: string;
  configPath: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let message = "";
  let configPath = "./config.json";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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

  if (!message) {
    throw new Error("Usage: node dist/cli/main.js --message \"...\" [--config /path/to/config.json]");
  }

  return { message, configPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
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
