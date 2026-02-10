import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppArgs {
  configPath: string;
}

export function parseAppArgs(argv: string[] = process.argv.slice(2)): AppArgs {
  let configPath = join(getMuaddibHome(), "config.json");

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--config" && argv[i + 1]) {
      configPath = argv[i + 1];
      i += 1;
    }
  }

  return { configPath };
}

export function loadConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}`);
  }

  return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
}

export function resolveMuaddibPath(path: string | undefined, fallback: string): string {
  if (!path) {
    return fallback;
  }

  if (path.startsWith("/")) {
    return path;
  }

  return join(getMuaddibHome(), path);
}

export function getMuaddibHome(): string {
  return process.env.MUADDIB_HOME ?? join(homedir(), ".muaddib");
}
