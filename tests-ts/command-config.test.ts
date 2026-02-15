import { describe, expect, it } from "vitest";

import { mergeRoomConfigs } from "../src/rooms/command/config.js";
import { MuaddibConfig } from "../src/config/muaddib-config.js";

describe("mergeRoomConfigs", () => {
  it("merges nested values, concatenates ignoreUsers, and concatenates promptVars strings", () => {
    const base = {
      command: {
        ignoreUsers: ["bot1"],
        historySize: 10,
      },
      promptVars: {
        output: "A",
      },
    };

    const override = {
      command: {
        ignoreUsers: ["bot2"],
      },
      promptVars: {
        output: "B",
      },
    };

    const merged = mergeRoomConfigs(base, override);

    expect((merged.command as any).ignoreUsers).toEqual(["bot1", "bot2"]);
    expect((merged.command as any).historySize).toBe(10);
    expect((merged.promptVars as any).output).toBe("AB");
  });

  it("merges room config from common + room override", () => {
    const config = {
      rooms: {
        common: {
          command: {
            history_size: 20,
          },
          prompt_vars: {
            intro: "A",
          },
        },
        irc: {
          command: {
            history_size: 40,
          },
          prompt_vars: {
            intro: "B",
          },
          varlink: {
            socket_path: "/tmp/irc.sock",
          },
        },
      },
    };

    const merged = MuaddibConfig.inMemory(config).getRoomConfig("irc");
    expect(merged.command?.historySize).toBe(40);
    expect(merged.promptVars?.intro).toBe("AB");
    expect(merged.varlink?.socketPath).toBe("/tmp/irc.sock");
  });
});
