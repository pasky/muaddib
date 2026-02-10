import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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

  const expandedPath = expandHomePath(path);
  if (isAbsolute(expandedPath)) {
    return expandedPath;
  }

  return join(getMuaddibHome(), expandedPath);
}

export function getMuaddibHome(): string {
  const envHome = process.env.MUADDIB_HOME;
  if (envHome) {
    return resolve(expandHomePath(envHome));
  }

  return join(homedir(), ".muaddib");
}

function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}
