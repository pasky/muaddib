import { CONSOLE_LOGGER, type Logger } from "../app/logging.js";
import { MuaddibConfig } from "../config/muaddib-config.js";

export function assertNoDeferredFeatureConfig(
  config: MuaddibConfig,
  logger: Logger = CONSOLE_LOGGER,
): void {
  const raw = config.toObject();

  const questsAt = (key: string, value: unknown): boolean => {
    if (value === undefined) return false;
    const enabled = value === true ||
      (typeof value === "object" && value !== null && (value as Record<string, unknown>).enabled === true);
    if (enabled) {
      throw new Error(
        `Deferred features are not supported in the TypeScript runtime. Disable or remove unsupported config keys: ${key}.`,
      );
    }
    logger.warn(
      `Deferred features are not supported in the TypeScript runtime and will be ignored unless explicitly enabled: ${key}.`,
    );
    return true;
  };

  const chronicler = raw.chronicler as Record<string, unknown> | undefined;
  questsAt("chronicler.quests", chronicler?.quests);
  questsAt("quests", raw.quests);
}
