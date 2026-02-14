import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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

  if (path === ":memory:") {
    return path;
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
