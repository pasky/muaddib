import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
