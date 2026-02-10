import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveMuaddibPath } from "../src/app/bootstrap.js";
import { runMuaddibMain } from "../src/app/main.js";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.MUADDIB_HOME;

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

async function runWithConfig(config: Record<string, unknown>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "muaddib-app-main-"));
  tempDirs.push(dir);

  const mutableConfig = config as any;
  mutableConfig.history ??= {};
  mutableConfig.history.database ??= {};
  mutableConfig.history.database.path ??= join(dir, "chat_history.db");

  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(mutableConfig), "utf-8");

  await runMuaddibMain(["--config", configPath]);
}

describe("resolveMuaddibPath", () => {
  it("expands '~' paths, preserves absolute paths, and resolves relative paths under MUADDIB_HOME", () => {
    process.env.MUADDIB_HOME = "/tmp/mu-home";

    expect(resolveMuaddibPath("~/chat_history.db", "/fallback.db")).toBe(
      join(homedir(), "chat_history.db"),
    );
    expect(resolveMuaddibPath("/var/lib/muaddib/chat_history.db", "/fallback.db")).toBe(
      "/var/lib/muaddib/chat_history.db",
    );
    expect(resolveMuaddibPath("chat_history.db", "/fallback.db")).toBe(
      "/tmp/mu-home/chat_history.db",
    );
  });
});

describe("runMuaddibMain", () => {
  it("throws when Discord is enabled without token", async () => {
    await expect(
      runWithConfig({
        history: {
          database: {
            path: "/tmp/muaddib-test-history.db",
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
            enabled: false,
          },
        },
      }),
    ).rejects.toThrow("Discord room is enabled but rooms.discord.token is missing.");
  });

  it("throws when Slack is enabled without app token", async () => {
    await expect(
      runWithConfig({
        history: {
          database: {
            path: "/tmp/muaddib-test-history.db",
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
            enabled: true,
            workspaces: {
              T123: {
                bot_token: "xoxb-demo",
              },
            },
          },
        },
      }),
    ).rejects.toThrow("Slack room is enabled but rooms.slack.app_token is missing.");
  });

  it("throws when IRC is enabled without varlink socket path", async () => {
    await expect(
      runWithConfig({
        history: {
          database: {
            path: "/tmp/muaddib-test-history.db",
          },
        },
        rooms: {
          common: {
            command: baseCommandConfig(),
          },
          irc: {
            enabled: true,
          },
          discord: {
            enabled: false,
          },
          slack: {
            enabled: false,
          },
        },
      }),
    ).rejects.toThrow("IRC room is enabled but rooms.irc.varlink.socket_path is missing.");
  });

  it("throws when no monitors are enabled", async () => {
    await expect(
      runWithConfig({
        history: {
          database: {
            path: "/tmp/muaddib-test-history.db",
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
      }),
    ).rejects.toThrow("No room monitors enabled.");
  });
});
