import { CONSOLE_LOGGER, type Logger } from "../app/logging.js";
import { MuaddibConfig } from "../config/muaddib-config.js";

function isExplicitlyEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "object" && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).enabled === true) return true;
  return false;
}

export function assertNoDeferredFeatureConfig(
  config: MuaddibConfig,
  logger: Logger = CONSOLE_LOGGER,
): void {
  const raw = config.toObject();
  const questLocations = [
    { path: "chronicler.quests", value: (raw.chronicler as Record<string, unknown> | undefined)?.quests },
    { path: "quests", value: raw.quests },
  ].filter((loc) => loc.value !== undefined);

  const blocking = questLocations.filter((loc) => isExplicitlyEnabled(loc.value));
  const ignored = questLocations.filter((loc) => !isExplicitlyEnabled(loc.value));

  if (ignored.length > 0) {
    logger.warn(
      `Deferred features are not supported in the TypeScript runtime and will be ignored unless explicitly enabled: ${ignored.map((l) => l.path).join(", ")}.`,
    );
  }

  if (blocking.length > 0) {
    throw new Error(
      `Deferred features are not supported in the TypeScript runtime. Disable or remove unsupported config keys: ${blocking.map((l) => l.path).join(", ")}.`,
    );
  }
}
