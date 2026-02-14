// Re-export from the canonical config module for backward compat.
export { deepMergeConfig } from "../../config/muaddib-config.js";

import { MuaddibConfig } from "../../config/muaddib-config.js";

export function getRoomConfig(config: Record<string, unknown>, roomName: string): Record<string, unknown> {
  return MuaddibConfig.inMemory(config).getRoomConfig(roomName);
}
