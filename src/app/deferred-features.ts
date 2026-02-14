import { MuaddibConfig } from "../config/muaddib-config.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isExplicitlyEnabled(value: unknown): boolean {
  if (value === true) {
    return true;
  }

  if (isObject(value) && value.enabled === true) {
    return true;
  }

  return false;
}

interface DeferredFeatureConfigPaths {
  blockingPaths: string[];
  ignoredPaths: string[];
}

export function collectDeferredFeatureConfigPaths(config: Record<string, unknown>): DeferredFeatureConfigPaths {
  const blockingPaths: string[] = [];
  const ignoredPaths: string[] = [];

  if (hasOwn(config, "chronicler")) {
    const chroniclerConfig = config.chronicler;
    if (isObject(chroniclerConfig) && hasOwn(chroniclerConfig, "quests")) {
      if (isExplicitlyEnabled(chroniclerConfig.quests)) {
        blockingPaths.push("chronicler.quests");
      } else {
        ignoredPaths.push("chronicler.quests");
      }
    }
  }

  if (hasOwn(config, "quests")) {
    if (isExplicitlyEnabled(config.quests)) {
      blockingPaths.push("quests");
    } else {
      ignoredPaths.push("quests");
    }
  }

  const rooms = config.rooms;
  if (isObject(rooms)) {
    for (const [roomName, roomConfig] of Object.entries(rooms)) {
      if (isObject(roomConfig) && hasOwn(roomConfig, "proactive")) {
        const path = `rooms.${roomName}.proactive`;
        if (isExplicitlyEnabled(roomConfig.proactive)) {
          blockingPaths.push(path);
        } else {
          ignoredPaths.push(path);
        }
      }
    }
  }

  return {
    blockingPaths: [...new Set(blockingPaths)].sort((a, b) => a.localeCompare(b)),
    ignoredPaths: [...new Set(ignoredPaths)].sort((a, b) => a.localeCompare(b)),
  };
}

interface DeferredFeatureLogger {
  warn(message: string): void;
}

export function assertNoDeferredFeatureConfig(
  config: MuaddibConfig,
  logger: DeferredFeatureLogger = console,
): void {
  const { blockingPaths, ignoredPaths } = collectDeferredFeatureConfigPaths(config.raw);

  if (ignoredPaths.length > 0) {
    logger.warn(
      `Deferred features are not supported in the TypeScript runtime and will be ignored unless explicitly enabled: ${ignoredPaths.join(", ")}.`,
    );
  }

  if (blockingPaths.length === 0) {
    return;
  }

  throw new Error(
    `Deferred features are not supported in the TypeScript runtime. Disable or remove unsupported config keys: ${blockingPaths.join(", ")}.`,
  );
}
