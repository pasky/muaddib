export function deepMergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(base)) {
    if (Array.isArray(value)) {
      result[key] = [...value];
    } else if (isObject(value)) {
      result[key] = deepMergeConfig(value, {});
    } else {
      result[key] = value;
    }
  }

  for (const [key, value] of Object.entries(override)) {
    if (key === "ignore_users" && Array.isArray(value)) {
      const baseList = (result[key] as unknown[] | undefined) ?? [];
      result[key] = [...baseList, ...value];
      continue;
    }

    if (key === "prompt_vars" && isObject(value)) {
      const baseVars = (result[key] as Record<string, unknown> | undefined) ?? {};
      const mergedVars: Record<string, unknown> = { ...baseVars };
      for (const [varKey, varValue] of Object.entries(value)) {
        if (typeof mergedVars[varKey] === "string" && typeof varValue === "string") {
          mergedVars[varKey] = `${mergedVars[varKey]}${varValue}`;
        } else {
          mergedVars[varKey] = varValue;
        }
      }
      result[key] = mergedVars;
      continue;
    }

    if (Array.isArray(value)) {
      result[key] = [...value];
      continue;
    }

    if (isObject(value) && isObject(result[key])) {
      result[key] = deepMergeConfig(result[key] as Record<string, unknown>, value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

export function getRoomConfig(config: Record<string, unknown>, roomName: string): Record<string, unknown> {
  const rooms = (config.rooms as Record<string, unknown> | undefined) ?? {};
  const common = (rooms.common as Record<string, unknown> | undefined) ?? {};
  const room = (rooms[roomName] as Record<string, unknown> | undefined) ?? {};
  return deepMergeConfig(common, room);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
