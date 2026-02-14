import { describe, expect, it } from "vitest";

import { deepMergeConfig } from "../src/rooms/command/config.js";
import { MuaddibConfig } from "../src/config/muaddib-config.js";

describe("deepMergeConfig", () => {
  it("merges nested values, concatenates ignore_users, and concatenates prompt_vars strings", () => {
    const base = {
      command: {
        ignore_users: ["bot1"],
        history_size: 10,
      },
      prompt_vars: {
        output: "A",
      },
    };

    const override = {
      command: {
        ignore_users: ["bot2"],
      },
      prompt_vars: {
        output: "B",
      },
    };

    const merged = deepMergeConfig(base, override);

    expect((merged.command as any).ignore_users).toEqual(["bot1", "bot2"]);
    expect((merged.command as any).history_size).toBe(10);
    expect((merged.prompt_vars as any).output).toBe("AB");
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
    expect(merged.command?.history_size).toBe(40);
    expect(merged.prompt_vars?.intro).toBe("AB");
    expect(merged.varlink?.socket_path).toBe("/tmp/irc.sock");
  });
});
