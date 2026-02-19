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
            historySize: 40,
            defaultMode: "classifier:serious",
            modes: {
              serious: {
                model: "openai:gpt-4o-mini",
                prompt: "You are {mynick}",
                triggers: {
                  "!s": {},
                },
              },
            },
            modeClassifier: {
              model: "openai:gpt-4o-mini",
              labels: {
                EASY_SERIOUS: "!s",
              },
              fallbackLabel: "EASY_SERIOUS",
            },
          },
        },
        irc: {
          command: {
            historySize: 40,
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

  it("accepts proactive config knobs (no longer deferred)", async () => {
    const dir = await createTempHome();

    const configPath = join(dir, "config.json");
    const config = {
      rooms: {
        common: {
          command: {
            historySize: 40,
            defaultMode: "classifier:serious",
            modes: {
              serious: {
                model: "openai:gpt-4o-mini",
                prompt: "You are {mynick}",
                triggers: {
                  "!s": {},
                },
              },
            },
            modeClassifier: {
              model: "openai:gpt-4o-mini",
              labels: {
                EASY_SERIOUS: "!s",
              },
              fallbackLabel: "EASY_SERIOUS",
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
    // Proactive is now supported natively — should NOT appear in deferred warnings.
    expect(systemLog).not.toContain("rooms.common.proactive");
  });

  it("fails fast when command.responseMaxBytes is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-cli-"));
    tempDirs.push(dir);

    const configPath = join(dir, "config.json");
    const config = {
      rooms: {
        common: {
          command: {
            historySize: 40,
            responseMaxBytes: 0,
            defaultMode: "classifier:serious",
            modes: {
              serious: {
                model: "openai:gpt-4o-mini",
                prompt: "You are {mynick}",
                triggers: {
                  "!s": {},
                },
              },
            },
            modeClassifier: {
              model: "openai:gpt-4o-mini",
              labels: {
                EASY_SERIOUS: "!s",
              },
              fallbackLabel: "EASY_SERIOUS",
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
    ).rejects.toThrow("command.responseMaxBytes must be a positive integer.");
  });

  it("fails fast when agent.refusalFallbackModel is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-cli-"));
    tempDirs.push(dir);

    const configPath = join(dir, "config.json");
    const config = {
      agent: {
        refusalFallbackModel: "gpt-4o-mini",
      },
      rooms: {
        common: {
          command: {
            historySize: 40,
            defaultMode: "classifier:serious",
            modes: {
              serious: {
                model: "openai:gpt-4o-mini",
                prompt: "You are {mynick}",
                triggers: {
                  "!s": {},
                },
              },
            },
            modeClassifier: {
              model: "openai:gpt-4o-mini",
              labels: {
                EASY_SERIOUS: "!s",
              },
              fallbackLabel: "EASY_SERIOUS",
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
      "Model 'gpt-4o-mini' must be fully qualified as provider:model.",
    );
  });

  it("accepts agent.refusalFallbackModel with deepseek provider", async () => {
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
      agent: {
        refusalFallbackModel: "deepseek:deepseek-reasoner",
      },
      rooms: {
        common: {
          command: {
            historySize: 40,
            defaultMode: "classifier:serious",
            modes: {
              serious: {
                model: "openai:gpt-4o-mini",
                prompt: "You are {mynick}",
                triggers: {
                  "!s": {},
                },
              },
            },
            modeClassifier: {
              model: "openai:gpt-4o-mini",
              labels: {
                EASY_SERIOUS: "!s",
              },
              fallbackLabel: "EASY_SERIOUS",
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

  it("fails fast when command.toolSummary.model is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-cli-"));
    tempDirs.push(dir);

    const configPath = join(dir, "config.json");
    const config = {
      rooms: {
        common: {
          command: {
            historySize: 40,
            defaultMode: "classifier:serious",
            modes: {
              serious: {
                model: "openai:gpt-4o-mini",
                prompt: "You are {mynick}",
                triggers: {
                  "!s": {},
                },
              },
            },
            modeClassifier: {
              model: "openai:gpt-4o-mini",
              labels: {
                EASY_SERIOUS: "!s",
              },
              fallbackLabel: "EASY_SERIOUS",
            },
            toolSummary: {
              model: "gpt-4o-mini",
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
      "Model 'gpt-4o-mini' must be fully qualified as provider:model.",
    );
  });

});
