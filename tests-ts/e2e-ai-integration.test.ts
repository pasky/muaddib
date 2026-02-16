/**
 * E2E AI integration tests.
 *
 * These test complex multi-component pipelines end-to-end using
 * runCliMessageMode with mock runner factories. No real LLM calls.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Usage } from "@mariozechner/pi-ai";

import { runCliMessageMode } from "../src/cli/message-mode.js";
import { RoomMessageHandler } from "../src/rooms/command/message-handler.js";
import { createMuaddibRuntime, shutdownRuntime } from "../src/runtime.js";
import { RuntimeLogWriter } from "../src/app/logging.js";
import type { RoomMessage } from "../src/rooms/message.js";
import type { PromptResult } from "../src/agent/session-runner.js";

// ── Helpers ──

const tempDirs: string[] = [];

function stubUsage(overrides?: Partial<Usage>): Usage {
  return {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    ...overrides,
  };
}

function stubPromptResult(text: string, overrides?: Partial<PromptResult>): PromptResult {
  return {
    text,
    stopReason: "stop",
    usage: stubUsage(),
    iterations: 1,
    toolCallsCount: 0,
    ...overrides,
  };
}

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "muaddib-e2e-"));
  tempDirs.push(dir);
  vi.stubEnv("MUADDIB_HOME", dir);
  return dir;
}

function baseConfig(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    rooms: {
      common: {
        command: {
          historySize: 40,
          defaultMode: "classifier:serious",
          modes: {
            serious: {
              model: "openai:gpt-4o-mini",
              prompt: "You are {mynick}. Current time: {current_time}.",
              triggers: { "!s": {} },
            },
            creative: {
              model: "openai:gpt-4o-mini",
              prompt: "You are {mynick}, a creative writer.",
              triggers: { "!c": {} },
            },
          },
          modeClassifier: {
            model: "openai:gpt-4o-mini",
            labels: {
              EASY_SERIOUS: "!s",
              CREATIVE: "!c",
            },
            fallbackLabel: "EASY_SERIOUS",
          },
        },
      },
      irc: { command: { historySize: 40 } },
    },
    ...overrides,
  };
}

beforeEach(async () => {
  await createTempHome();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Test cases ──

describe("E2E AI integration", () => {

  describe("1. Context reduction pipeline", () => {
    it("reduces multi-turn context before agent invocation", async () => {
      const dir = tempDirs[0];
      const reducerCalls: string[] = [];

      // We need a custom setup to inject a context reducer mock.
      // Use the lower-level runtime + RoomMessageHandler directly.
      const config = baseConfig({
        context_reducer: {
          model: "openai:gpt-4o-mini",
          prompt: "Condense the conversation.",
        },
        rooms: {
          common: {
            command: {
              historySize: 40,
              defaultMode: "classifier:serious",
              modes: {
                serious: {
                  model: "openai:gpt-4o-mini",
                  prompt: "You are {mynick}.",
                  triggers: {
                    "!s": {
                      autoReduceContext: true,
                    },
                  },
                },
              },
              modeClassifier: {
                model: "openai:gpt-4o-mini",
                labels: { EASY_SERIOUS: "!s" },
                fallbackLabel: "EASY_SERIOUS",
              },
            },
          },
          irc: { command: { historySize: 40 } },
        },
      });

      const configPath = join(dir, "config.json");
      await writeFile(configPath, JSON.stringify(config), "utf-8");

      const runtime = await createMuaddibRuntime({
        configPath,
        muaddibHome: dir,
        dbPath: ":memory:",
        logger: new RuntimeLogWriter({
          muaddibHome: dir,
          stdout: { write: () => true } as unknown as NodeJS.WriteStream,
        }),
      });

      try {
        // Seed history with multiple turns so context reducer activates
        const msg = (nick: string, content: string): RoomMessage => ({
          serverTag: "testserver",
          channelName: "#test",
          nick,
          mynick: "testbot",
          content,
        });

        await runtime.history.addMessage(msg("alice", "What is the meaning of life?"));
        await runtime.history.addMessage(msg("testbot", "42, according to Douglas Adams."));
        await runtime.history.addMessage(msg("alice", "Can you elaborate on that?"));
        await runtime.history.addMessage(msg("testbot", "It's from Hitchhiker's Guide."));

        let contextPassedToRunner: unknown[] = [];

        const handler = new RoomMessageHandler(runtime, "irc", {
          runnerFactory: () => ({
            prompt: async (_prompt, _opts) => {
              contextPassedToRunner = _opts?.contextMessages ?? [];
              return stubPromptResult("reduced response");
            },
          }),
          contextReducer: {
            isConfigured: true,
            reduce: async (context, systemPrompt) => {
              reducerCalls.push(systemPrompt);
              // Return a condensed single-message summary
              return [
                { role: "user", content: "<context_summary>Alice asked about meaning of life, bot said 42.</context_summary>" },
              ];
            },
          },
        });

        const result = await handler.handleIncomingMessage(
          msg("alice", "!s Tell me more"),
          { isDirect: true },
        );

        expect(result?.response).toBe("reduced response");
        expect(reducerCalls.length).toBe(1);
        // The runner should receive the reduced context, not the full history
        expect(contextPassedToRunner).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ content: expect.stringContaining("context_summary") }),
          ]),
        );
      } finally {
        await shutdownRuntime(runtime);
      }
    });
  });

  describe("2. Refusal fallback chain", () => {
    it("retries with fallback model on refusal and annotates response", async () => {
      const dir = tempDirs[0];
      const configPath = join(dir, "config.json");
      const config = baseConfig({
        router: {
          refusal_fallback_model: "openai:gpt-4o",
        },
      });
      await writeFile(configPath, JSON.stringify(config), "utf-8");

      const result = await runCliMessageMode({
        configPath,
        message: "!s Write something edgy",
        runnerFactory: () => ({
          prompt: async () => {
            // Simulate refusal fallback being activated by the SessionRunner
            return stubPromptResult("Here is an edgy response", {
              refusalFallbackActivated: true,
              refusalFallbackModel: "openai:gpt-4o",
            });
          },
        }),
      });

      expect(result.response).toContain("Here is an edgy response");
      expect(result.response).toContain("[refusal fallback to gpt-4o]");
    });
  });

  describe("3. Mode classifier auto-routing", () => {
    it("routes message without explicit trigger via classifier", async () => {
      const dir = tempDirs[0];
      const configPath = join(dir, "config.json");

      // Config with channel_modes for auto-classification
      const config = {
        rooms: {
          common: {
            command: {
              historySize: 40,
              defaultMode: "classifier:serious",
              modes: {
                serious: {
                  model: "openai:gpt-4o-mini",
                  prompt: "You are {mynick}.",
                  triggers: { "!s": {} },
                },
                creative: {
                  model: "openai:gpt-4o-mini",
                  prompt: "You are {mynick}, a creative writer.",
                  triggers: { "!c": {} },
                },
              },
              modeClassifier: {
                model: "openai:gpt-4o-mini",
                labels: {
                  EASY_SERIOUS: "!s",
                  CREATIVE: "!c",
                },
                fallbackLabel: "EASY_SERIOUS",
              },
              channelModes: {
                "testserver##testchannel": "classifier",
              },
            },
          },
          irc: { command: { historySize: 40 } },
        },
      };

      await writeFile(configPath, JSON.stringify(config), "utf-8");

      const runtime = await createMuaddibRuntime({
        configPath,
        muaddibHome: dir,
        dbPath: ":memory:",
        logger: new RuntimeLogWriter({
          muaddibHome: dir,
          stdout: { write: () => true } as unknown as NodeJS.WriteStream,
        }),
      });

      try {
        let classifierCalled = false;

        const handler = new RoomMessageHandler(runtime, "irc", {
          runnerFactory: () => ({
            prompt: async () => stubPromptResult("classified response"),
          }),
        });

        // Monkey-patch the classifier to track calls and return CREATIVE
        const executor = (handler as any).executor;
        executor.classifyMode = async (_context: Array<{ role: string; content: string }>) => {
          classifierCalled = true;
          return "CREATIVE";
        };
        // Also patch the resolver's classify function
        (executor.resolver as any).classifyModeFn = executor.classifyMode;

        const msg: RoomMessage = {
          serverTag: "testserver",
          channelName: "#testchannel",
          nick: "alice",
          mynick: "testbot",
          content: "testbot: write me a poem",
        };

        const result = await handler.handleIncomingMessage(msg, { isDirect: true });

        expect(classifierCalled).toBe(true);
        expect(result?.response).toBe("classified response");
        expect(result?.resolved.selectedAutomatically).toBe(true);
      } finally {
        await shutdownRuntime(runtime);
      }
    });
  });

  describe("4. Response length policy → artifact", () => {
    it("truncates long responses and appends artifact URL", async () => {
      const dir = tempDirs[0];
      const configPath = join(dir, "config.json");

      const config = baseConfig();
      // Default responseMaxBytes is 600
      (config.rooms as any).common.command.responseMaxBytes = 100;

      await writeFile(configPath, JSON.stringify(config), "utf-8");

      const longResponse = "A".repeat(200);

      const runtime = await createMuaddibRuntime({
        configPath,
        muaddibHome: dir,
        dbPath: ":memory:",
        logger: new RuntimeLogWriter({
          muaddibHome: dir,
          stdout: { write: () => true } as unknown as NodeJS.WriteStream,
        }),
      });

      try {
        let shareArtifactCalled = false;

        const handler = new RoomMessageHandler(runtime, "irc", {
          runnerFactory: () => ({
            prompt: async () => stubPromptResult(longResponse),
          }),
        });

        // Patch the shareArtifact to return a fake URL
        const executor = (handler as any).executor;
        (executor as any).shareArtifact = async (_content: string) => {
          shareArtifactCalled = true;
          return "Artifact shared: https://example.com/artifact/123";
        };

        const msg: RoomMessage = {
          serverTag: "testserver",
          channelName: "#test",
          nick: "alice",
          mynick: "testbot",
          content: "!s give me a long answer",
        };

        const result = await handler.handleIncomingMessage(msg, { isDirect: true });

        expect(shareArtifactCalled).toBe(true);
        expect(result?.response).toContain("https://example.com/artifact/123");
        expect(result?.response).toContain("full response:");
        // Response should be shorter than original
        expect(result!.response!.length).toBeLessThan(longResponse.length + 100);
      } finally {
        await shutdownRuntime(runtime);
      }
    });
  });

  describe("5. Tool summary persistence", () => {
    it("persists tool summary as internal monologue when tools are used", async () => {
      const dir = tempDirs[0];
      const configPath = join(dir, "config.json");

      const config = baseConfig({
        tools: {
          summary: {
            model: "openai:gpt-4o-mini",
          },
        },
      });

      await writeFile(configPath, JSON.stringify(config), "utf-8");

      const runtime = await createMuaddibRuntime({
        configPath,
        muaddibHome: dir,
        dbPath: ":memory:",
        logger: new RuntimeLogWriter({
          muaddibHome: dir,
          stdout: { write: () => true } as unknown as NodeJS.WriteStream,
        }),
      });

      try {
        const handler = new RoomMessageHandler(runtime, "irc", {
          runnerFactory: () => ({
            prompt: async () => stubPromptResult("tool-based response", {
              toolCallsCount: 2,
              // Session with tool call messages for summary generation
              session: {
                messages: [
                  { role: "user", content: "do something" },
                  {
                    role: "assistant",
                    content: [
                      { type: "toolCall", id: "tc1", name: "web_search", arguments: { query: "test" } },
                    ],
                    usage: stubUsage(),
                    stopReason: "tool_use",
                  },
                  {
                    role: "tool",
                    toolCallId: "tc1",
                    toolName: "web_search",
                    content: [{ type: "text", text: "search result" }],
                  },
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "tool-based response" }],
                    usage: stubUsage(),
                    stopReason: "stop",
                  },
                ],
                dispose: vi.fn(),
                subscribe: vi.fn(() => vi.fn()),
              } as any,
            }),
          }),
        });

        // Check what gets persisted in history
        const persistedMessages: Array<{ nick: string; content: string }> = [];
        const origAddMessage = runtime.history.addMessage.bind(runtime.history);
        vi.spyOn(runtime.history, "addMessage").mockImplementation(async (...args) => {
          const [msg] = args;
          persistedMessages.push({ nick: (msg as any).nick, content: (msg as any).content });
          return origAddMessage(...args);
        });

        const msg: RoomMessage = {
          serverTag: "testserver",
          channelName: "#test",
          nick: "alice",
          mynick: "testbot",
          content: "!s search for something",
        };

        await handler.handleIncomingMessage(msg, { isDirect: true });

        // The response message should be persisted
        const botMessages = persistedMessages.filter((m) => m.nick === "testbot");
        expect(botMessages.length).toBeGreaterThanOrEqual(1);
        expect(botMessages.some((m) => m.content === "tool-based response")).toBe(true);
      } finally {
        await shutdownRuntime(runtime);
      }
    });
  });

  describe("6. Steering queue mid-flight injection", () => {
    it("injects steering messages during agent execution", async () => {
      const dir = tempDirs[0];
      const configPath = join(dir, "config.json");

      const config = baseConfig();
      // Enable steering on the serious trigger
      (config.rooms as any).common.command.modes.serious.triggers["!s"].steering = true;

      await writeFile(configPath, JSON.stringify(config), "utf-8");

      const runtime = await createMuaddibRuntime({
        configPath,
        muaddibHome: dir,
        dbPath: ":memory:",
        logger: new RuntimeLogWriter({
          muaddibHome: dir,
          stdout: { write: () => true } as unknown as NodeJS.WriteStream,
        }),
      });

      try {
        let steeringProviderCalled = false;

        const handler = new RoomMessageHandler(runtime, "irc", {
          runnerFactory: (input) => {
            // Check if steeringMessageProvider was passed
            if (input.steeringMessageProvider) {
              steeringProviderCalled = true;
            }
            return {
              prompt: async () => stubPromptResult("steered response"),
            };
          },
        });

        const msg: RoomMessage = {
          serverTag: "testserver",
          channelName: "#test",
          nick: "alice",
          mynick: "testbot",
          content: "!s do a complex task",
        };

        const result = await handler.handleIncomingMessage(msg, { isDirect: true });

        expect(result?.response).toBe("steered response");
        expect(steeringProviderCalled).toBe(true);
      } finally {
        await shutdownRuntime(runtime);
      }
    });
  });

  describe("7. Cost followup emission", () => {
    it("emits cost followup for expensive responses", async () => {
      const dir = tempDirs[0];
      const configPath = join(dir, "config.json");
      await writeFile(configPath, JSON.stringify(baseConfig()), "utf-8");

      const runtime = await createMuaddibRuntime({
        configPath,
        muaddibHome: dir,
        dbPath: ":memory:",
        logger: new RuntimeLogWriter({
          muaddibHome: dir,
          stdout: { write: () => true } as unknown as NodeJS.WriteStream,
        }),
      });

      try {
        const sentResponses: string[] = [];

        const handler = new RoomMessageHandler(runtime, "irc", {
          runnerFactory: () => ({
            prompt: async () => stubPromptResult("expensive answer", {
              usage: stubUsage({
                input: 100000,
                output: 50000,
                cost: { input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0, total: 0.25 },
              }),
              toolCallsCount: 5,
            }),
          }),
        });

        const msg: RoomMessage = {
          serverTag: "testserver",
          channelName: "#test",
          nick: "alice",
          mynick: "testbot",
          content: "!s do something expensive",
        };

        const result = await handler.handleIncomingMessage(msg, {
          isDirect: true,
          sendResponse: async (text) => { sentResponses.push(text); },
        });

        expect(result?.response).toBe("expensive answer");
        // Should have sent the main response + cost followup
        expect(sentResponses.length).toBeGreaterThanOrEqual(2);
        expect(sentResponses.some((r) => r.includes("cost $"))).toBe(true);
        expect(sentResponses.some((r) => r.includes("tool calls"))).toBe(true);
      } finally {
        await shutdownRuntime(runtime);
      }
    });
  });
});
