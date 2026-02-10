import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runMuaddibMain } from "../src/app/main.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function baseCommandConfig() {
  return {
    history_size: 40,
    default_mode: "classifier:serious",
    modes: {
      serious: {
        model: "openai:gpt-4o-mini",
        prompt: "You are {mynick}",
        triggers: {
          "!s": {},
        },
      },
    },
    mode_classifier: {
      model: "openai:gpt-4o-mini",
      labels: {
        EASY_SERIOUS: "!s",
      },
      fallback_label: "EASY_SERIOUS",
    },
  };
}

describe("runMuaddibMain", () => {
  it("supports enabled/disabled monitor orchestration via config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-app-main-"));
    tempDirs.push(dir);

    const configPath = join(dir, "config.json");
    const config = {
      history: {
        database: {
          path: join(dir, "chat_history.db"),
        },
      },
      rooms: {
        common: {
          command: baseCommandConfig(),
        },
        irc: {
          enabled: false,
        },
        discord: {
          enabled: true,
        },
        slack: {
          enabled: true,
        },
      },
    };

    await writeFile(configPath, JSON.stringify(config), "utf-8");

    await expect(runMuaddibMain(["--config", configPath])).resolves.toBeUndefined();
  });

  it("throws when no monitors are enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-app-main-"));
    tempDirs.push(dir);

    const configPath = join(dir, "config.json");
    const config = {
      history: {
        database: {
          path: join(dir, "chat_history.db"),
        },
      },
      rooms: {
        common: {
          command: baseCommandConfig(),
        },
        irc: {
          enabled: false,
        },
        discord: {
          enabled: false,
        },
        slack: {
          enabled: false,
        },
      },
    };

    await writeFile(configPath, JSON.stringify(config), "utf-8");

    await expect(runMuaddibMain(["--config", configPath])).rejects.toThrow(
      "No room monitors enabled.",
    );
  });
});
