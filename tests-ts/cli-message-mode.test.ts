import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCliMessageMode } from "../src/cli/message-mode.js";

const tempDirs: string[] = [];

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "muaddib-cli-home-"));
  tempDirs.push(dir);
  vi.stubEnv("MUADDIB_HOME", dir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "muaddib-cli-"));
  tempDirs.push(dir);
  vi.stubEnv("MUADDIB_HOME", dir);
  return dir;
}

describe("runCliMessageMode", () => {
  it("executes parse->context->runner path and returns formatted response", async () => {
    const dir = await createTempHome();

    const configPath = join(dir, "config.json");
    const config = {
      rooms: {
        common: {
          command: {
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
          },
        },
        irc: {
          command: {
            history_size: 40,
          },
        },
      },
    };

    await writeFile(configPath, JSON.stringify(config), "utf-8");

    const result = await runCliMessageMode({
      configPath,
      message: "!s hi",
      runnerFactory: () => ({
        prompt: async () => ({
          assistantMessage: {
            role: "assistant",
            content: [{ type: "text", text: "cli ok" }],
            api: "openai-completions",
            provider: "openai",
            model: "gpt-4o-mini",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          text: "cli ok",
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      }),
    });

    expect(result.response).toBe("cli ok");
    expect(result.mode).toBe("serious");
    expect(result.trigger).toBe("!s");

    const date = new Date().toISOString().slice(0, 10);
    const arcLogDir = join(dir, "logs", date, "testserver##testchannel");
    const arcLogs = await readdir(arcLogDir);
    expect(arcLogs.length).toBeGreaterThan(0);
  });

  it("ignores deferred proactive config knobs when not explicitly enabled", async () => {
    const dir = await createTempHome();

    const configPath = join(dir, "config.json");
    const config = {
      rooms: {
        common: {
          command: {
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
          },
          proactive: {
            interjecting: ["libera##muaddib"],
          },
        },
      },
    };

    await writeFile(configPath, JSON.stringify(config), "utf-8");

    const result = await runCliMessageMode({
      configPath,
      message: "!s hi",
      runnerFactory: () => ({
        prompt: async () => ({
          assistantMessage: {
            role: "assistant",
            content: [{ type: "text", text: "cli ok" }],
            api: "openai-completions",
            provider: "openai",
            model: "gpt-4o-mini",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          text: "cli ok",
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      }),
    });

    expect(result.response).toBe("cli ok");

    const date = new Date().toISOString().slice(0, 10);
    const systemLogPath = join(dir, "logs", date, "system.log");
    const systemLog = await readFile(systemLogPath, "utf-8");
    expect(systemLog).toContain("rooms.common.proactive");
  });

  it("fails fast on explicitly enabled deferred proactive config knobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-cli-"));
    tempDirs.push(dir);

    const configPath = join(dir, "config.json");
    const config = {
      rooms: {
        common: {
          command: {
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
          },
          proactive: {
            enabled: true,
            interjecting: ["libera##muaddib"],
          },
        },
      },
    };

    await writeFile(configPath, JSON.stringify(config), "utf-8");

    await expect(
      runCliMessageMode({
        configPath,
        message: "!s hi",
      }),
    ).rejects.toThrow(
      "Deferred features are not supported in the TypeScript runtime. Disable or remove unsupported config keys: rooms.common.proactive.",
    );
  });

  it("fails fast with operator guidance on provider credential refresh/session config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-cli-"));
    tempDirs.push(dir);

    const configPath = join(dir, "config.json");
    const config = {
      providers: {
        openai: {
          session: {
            id: "session_123",
          },
        },
      },
      rooms: {
        common: {
          command: {
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
          },
        },
      },
    };

    await writeFile(configPath, JSON.stringify(config), "utf-8");

    await expect(
      runCliMessageMode({
        configPath,
        message: "!s hi",
      }),
    ).rejects.toThrow(
      "Operator guidance: remove providers.openai.session and use providers.openai.key as a static string or OPENAI_API_KEY.",
    );
  });

  it("fails fast when command.response_max_bytes is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-cli-"));
    tempDirs.push(dir);

    const configPath = join(dir, "config.json");
    const config = {
      rooms: {
        common: {
          command: {
            history_size: 40,
            response_max_bytes: 0,
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
          },
        },
      },
    };

    await writeFile(configPath, JSON.stringify(config), "utf-8");

    await expect(
      runCliMessageMode({
        configPath,
        message: "!s hi",
      }),
    ).rejects.toThrow("command.response_max_bytes must be a positive integer.");
  });

  it("fails fast when router.refusal_fallback_model is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-cli-"));
    tempDirs.push(dir);

    const configPath = join(dir, "config.json");
    const config = {
      router: {
        refusal_fallback_model: "gpt-4o-mini",
      },
      rooms: {
        common: {
          command: {
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
          },
        },
      },
    };

    await writeFile(configPath, JSON.stringify(config), "utf-8");

    await expect(
      runCliMessageMode({
        configPath,
        message: "!s hi",
      }),
    ).rejects.toThrow(
      "Invalid router.refusal_fallback_model 'gpt-4o-mini': Model 'gpt-4o-mini' must be fully qualified as provider:model.",
    );
  });

  it("fails fast when router.refusal_fallback_model points to unsupported provider/model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-cli-"));
    tempDirs.push(dir);

    const configPath = join(dir, "config.json");
    const config = {
      router: {
        refusal_fallback_model: "unknown:model",
      },
      rooms: {
        common: {
          command: {
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
          },
        },
      },
    };

    await writeFile(configPath, JSON.stringify(config), "utf-8");

    await expect(
      runCliMessageMode({
        configPath,
        message: "!s hi",
      }),
    ).rejects.toThrow("Unsupported router.refusal_fallback_model 'unknown:model': Unknown provider 'unknown'");
  });

  it("accepts router.refusal_fallback_model with deepseek provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-cli-"));
    tempDirs.push(dir);

    const configPath = join(dir, "config.json");
    const config = {
      providers: {
        deepseek: {
          key: "test-deepseek-key",
          url: "https://api.deepseek.com/anthropic/v1/messages",
        },
      },
      router: {
        refusal_fallback_model: "deepseek:deepseek-reasoner",
      },
      rooms: {
        common: {
          command: {
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
          },
        },
      },
    };

    await writeFile(configPath, JSON.stringify(config), "utf-8");

    const result = await runCliMessageMode({
      configPath,
      message: "!s hi",
      runnerFactory: () => ({
        prompt: async () => ({
          assistantMessage: {
            role: "assistant",
            content: [{ type: "text", text: "cli ok" }],
            api: "openai-completions",
            provider: "openai",
            model: "gpt-4o-mini",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          text: "cli ok",
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      }),
    });

    expect(result.response).toBe("cli ok");
  });

  it("fails fast when tools.summary.model is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-cli-"));
    tempDirs.push(dir);

    const configPath = join(dir, "config.json");
    const config = {
      tools: {
        summary: {
          model: "gpt-4o-mini",
        },
      },
      rooms: {
        common: {
          command: {
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
          },
        },
      },
    };

    await writeFile(configPath, JSON.stringify(config), "utf-8");

    await expect(
      runCliMessageMode({
        configPath,
        message: "!s hi",
      }),
    ).rejects.toThrow(
      "Invalid tools.summary.model 'gpt-4o-mini': Model 'gpt-4o-mini' must be fully qualified as provider:model.",
    );
  });

  it("fails fast when tools.summary.model points to unsupported provider/model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-cli-"));
    tempDirs.push(dir);

    const configPath = join(dir, "config.json");
    const config = {
      tools: {
        summary: {
          model: "unknown:model",
        },
      },
      rooms: {
        common: {
          command: {
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
          },
        },
      },
    };

    await writeFile(configPath, JSON.stringify(config), "utf-8");

    await expect(
      runCliMessageMode({
        configPath,
        message: "!s hi",
      }),
    ).rejects.toThrow("Unsupported tools.summary.model 'unknown:model': Unknown provider 'unknown'");
  });
});
