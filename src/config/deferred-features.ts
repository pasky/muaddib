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

interface DeferredFeatureLogger {
  warn(message: string): void;
}

export function assertNoDeferredFeatureConfig(
  config: MuaddibConfig,
  logger: DeferredFeatureLogger = console,
): void {
  const blockingPaths: string[] = [];
  const ignoredPaths: string[] = [];
  const raw = config.toObject();

  if (hasOwn(raw, "chronicler")) {
    const chroniclerConfig = raw.chronicler;
    if (isObject(chroniclerConfig) && hasOwn(chroniclerConfig, "quests")) {
      if (isExplicitlyEnabled(chroniclerConfig.quests)) {
        blockingPaths.push("chronicler.quests");
      } else {
        ignoredPaths.push("chronicler.quests");
      }
    }
  }

  if (hasOwn(raw, "quests")) {
    if (isExplicitlyEnabled(raw.quests)) {
      blockingPaths.push("quests");
    } else {
      ignoredPaths.push("quests");
    }
  }

  // Proactive interjection is now supported natively — no longer deferred.

  const uniqueIgnored = [...new Set(ignoredPaths)].sort((a, b) => a.localeCompare(b));
  const uniqueBlocking = [...new Set(blockingPaths)].sort((a, b) => a.localeCompare(b));

  if (uniqueIgnored.length > 0) {
    logger.warn(
      `Deferred features are not supported in the TypeScript runtime and will be ignored unless explicitly enabled: ${uniqueIgnored.join(", ")}.`,
    );
  }

  if (uniqueBlocking.length === 0) {
    return;
  }

  throw new Error(
    `Deferred features are not supported in the TypeScript runtime. Disable or remove unsupported config keys: ${uniqueBlocking.join(", ")}.`,
  );
}
