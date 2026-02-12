import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveMuaddibPath } from "../src/app/bootstrap.js";
import {
  createSendRetryEventLogger,
  runMuaddibMain,
} from "../src/app/main.js";

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

async function createConfigDir(config: Record<string, unknown>): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "muaddib-app-main-"));
  tempDirs.push(dir);

  const mutableConfig = config as any;
  mutableConfig.history ??= {};
  mutableConfig.history.database ??= {};
  mutableConfig.history.database.path ??= join(dir, "chat_history.db");

  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(mutableConfig), "utf-8");

  process.env.MUADDIB_HOME = dir;

  return { dir, configPath };
}

async function runWithConfig(config: Record<string, unknown>): Promise<void> {
  const { configPath } = await createConfigDir(config);
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

describe("createSendRetryEventLogger", () => {
  it("emits operator-visible retry logs and metric lines", () => {
    const infos: string[] = [];
    const warns: string[] = [];
    const errors: string[] = [];

    const emit = createSendRetryEventLogger({
      info: (...args: unknown[]) => {
        infos.push(args.map(String).join(" "));
      },
      warn: (...args: unknown[]) => {
        warns.push(args.map(String).join(" "));
      },
      error: (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      },
    });

    emit({
      type: "retry",
      retryable: true,
      platform: "slack",
      destination: "C123",
      attempt: 1,
      maxAttempts: 3,
      retryAfterMs: 1500,
      error: new Error("rate limited"),
    });

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("[muaddib][send-retry]");
    expect(warns[0]).toContain("\"type\":\"retry\"");
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain("[muaddib][metric]");
    expect(infos[0]).toContain("\"platform\":\"slack\"");
    expect(errors).toHaveLength(0);
  });

  it("emits operator-visible failure logs and metric lines", () => {
    const infos: string[] = [];
    const warns: string[] = [];
    const errors: string[] = [];

    const emit = createSendRetryEventLogger({
      info: (...args: unknown[]) => {
        infos.push(args.map(String).join(" "));
      },
      warn: (...args: unknown[]) => {
        warns.push(args.map(String).join(" "));
      },
      error: (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      },
    });

    emit({
      type: "failed",
      retryable: false,
      platform: "discord",
      destination: "chan-1",
      attempt: 1,
      maxAttempts: 3,
      retryAfterMs: null,
      error: new Error("forbidden"),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[muaddib][send-retry]");
    expect(errors[0]).toContain("\"type\":\"failed\"");
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain("[muaddib][metric]");
    expect(infos[0]).toContain("\"platform\":\"discord\"");
    expect(warns).toHaveLength(0);
  });
});

describe("runMuaddibMain", () => {
  it("writes startup and failure logs to $MUADDIB_HOME/logs/YYYY-MM-DD/system.log", async () => {
    const { dir, configPath } = await createConfigDir({
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
    });

    process.env.MUADDIB_HOME = dir;

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as any);

    await expect(runMuaddibMain(["--config", configPath])).rejects.toThrow("No room monitors enabled.");

    const datePath = new Date().toISOString().slice(0, 10);
    const systemLogPath = join(dir, "logs", datePath, "system.log");
    const systemLog = await readFile(systemLogPath, "utf-8");

    expect(systemLog).toContain(" - muaddib.app.main - INFO - Starting TypeScript runtime");
    expect(systemLog).toContain(" - muaddib.app.main - ERROR - No room monitors enabled.");

    const stdout = stdoutSpy.mock.calls.map((args) => String(args[0] ?? "")).join("");
    expect(stdout).toContain(" - muaddib.app.main - INFO - Starting TypeScript runtime");
    expect(stdout).toContain(" - muaddib.app.main - ERROR - No room monitors enabled.");

    stdoutSpy.mockRestore();
  });

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

  it("fails fast when command.response_max_bytes is invalid", async () => {
    await expect(
      runWithConfig({
        history: {
          database: {
            path: "/tmp/muaddib-test-history.db",
          },
        },
        rooms: {
          common: {
            command: {
              ...baseCommandConfig(),
              response_max_bytes: 0,
            },
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
    ).rejects.toThrow("command.response_max_bytes must be a positive integer.");
  });

  it("ignores deferred proactive/chronicler/quests config knobs when not explicitly enabled", async () => {
    const { dir, configPath } = await createConfigDir({
      history: {
        database: {
          path: "/tmp/muaddib-test-history.db",
        },
      },
      chronicler: {
        model: "openai:gpt-4o-mini",
        quests: {
          arcs: ["libera##muaddib"],
        },
      },
      quests: {
        arcs: ["libera##muaddib"],
      },
      rooms: {
        common: {
          command: baseCommandConfig(),
          proactive: {
            interjecting: ["libera##muaddib"],
          },
        },
        irc: {
          enabled: false,
          proactive: {
            interjecting: ["libera##muaddib"],
          },
        },
        discord: {
          enabled: false,
        },
        slack: {
          enabled: false,
        },
      },
    });

    process.env.MUADDIB_HOME = dir;

    await expect(runMuaddibMain(["--config", configPath])).rejects.toThrow("No room monitors enabled.");

    const datePath = new Date().toISOString().slice(0, 10);
    const systemLogPath = join(dir, "logs", datePath, "system.log");
    const systemLog = await readFile(systemLogPath, "utf-8");

    expect(systemLog).toContain(
      "Deferred features are not supported in the TypeScript runtime and will be ignored",
    );
    expect(systemLog).toContain("chronicler");
    expect(systemLog).toContain("rooms.common.proactive");
  });

  it("throws when deferred config knobs are explicitly enabled", async () => {
    await expect(
      runWithConfig({
        history: {
          database: {
            path: "/tmp/muaddib-test-history.db",
          },
        },
        chronicler: {
          enabled: true,
          model: "openai:gpt-4o-mini",
        },
        rooms: {
          common: {
            command: baseCommandConfig(),
            proactive: {
              enabled: true,
              interjecting: ["libera##muaddib"],
            },
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
    ).rejects.toThrow(
      "Deferred features are not supported in the TypeScript runtime. Disable or remove unsupported config keys: chronicler, rooms.common.proactive.",
    );
  });

  it("throws with operator guidance when provider credential refresh/session config is present", async () => {
    await expect(
      runWithConfig({
        history: {
          database: {
            path: "/tmp/muaddib-test-history.db",
          },
        },
        providers: {
          openai: {
            key: {
              session_id: "sess_123",
            },
            oauth: {
              refresh_token: "refresh_123",
            },
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
    ).rejects.toThrow(
      "Operator guidance: remove providers.openai.key, providers.openai.oauth and use providers.openai.key as a static string or OPENAI_API_KEY.",
    );
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
