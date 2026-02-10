function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function collectDeferredFeatureConfigPaths(config: Record<string, unknown>): string[] {
  const paths: string[] = [];

  if (hasOwn(config, "chronicler")) {
    paths.push("chronicler");

    const chroniclerConfig = config.chronicler;
    if (isObject(chroniclerConfig) && hasOwn(chroniclerConfig, "quests")) {
      paths.push("chronicler.quests");
    }
  }

  if (hasOwn(config, "quests")) {
    paths.push("quests");
  }

  const rooms = config.rooms;
  if (isObject(rooms)) {
    for (const [roomName, roomConfig] of Object.entries(rooms)) {
      if (isObject(roomConfig) && hasOwn(roomConfig, "proactive")) {
        paths.push(`rooms.${roomName}.proactive`);
      }
    }
  }

  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

export function assertNoDeferredFeatureConfig(config: Record<string, unknown>): void {
  const unsupportedPaths = collectDeferredFeatureConfigPaths(config);
  if (unsupportedPaths.length === 0) {
    return;
  }

  throw new Error(
    `Deferred features are not supported in the TypeScript runtime. Remove unsupported config keys: ${unsupportedPaths.join(", ")}.`,
  );
}
