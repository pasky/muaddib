import { describe, expect, it } from "vitest";

import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { RoomCommandHandlerTs } from "../src/rooms/command/command-handler.js";
import type { RoomMessage } from "../src/rooms/message.js";

const roomConfig = {
  command: {
    history_size: 40,
    default_mode: "classifier:serious",
    modes: {
      serious: {
        model: "openai:gpt-4o-mini",
        prompt: "You are {mynick}. Time={current_time}.",
        reasoning_effort: "low",
        steering: true,
        triggers: {
          "!s": {},
          "!a": { reasoning_effort: "medium" },
        },
      },
      sarcastic: {
        model: "openai:gpt-4o-mini",
        prompt: "Sarcastic mode for {mynick}",
        steering: false,
        triggers: {
          "!d": {},
        },
      },
    },
    mode_classifier: {
      model: "openai:gpt-4o-mini",
      labels: {
        EASY_SERIOUS: "!s",
        SARCASTIC: "!d",
      },
      fallback_label: "EASY_SERIOUS",
    },
  },
  prompt_vars: {
    output: "",
  },
} as const;

function makeMessage(content: string): RoomMessage {
  return {
    serverTag: "libera",
    channelName: "#test",
    nick: "alice",
    mynick: "muaddib",
    content,
  };
}

describe("RoomCommandHandlerTs", () => {
  it("routes command to runner with resolved mode/model and context", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const incoming = makeMessage("!s hello there");
    await history.addMessage(incoming);

    let runnerModel: string | null = null;
    let runnerPrompt = "";
    let runnerContextLength = -1;

    const handler = new RoomCommandHandlerTs({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: (input) => {
        runnerModel = input.model;
        return {
          runSingleTurn: async (prompt, options) => {
            runnerPrompt = prompt;
            runnerContextLength = options?.contextMessages?.length ?? 0;
            return {
              assistantMessage: {
                role: "assistant",
                content: [{ type: "text", text: "done" }],
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
              text: "done",
              stopReason: "stop",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            };
          },
        };
      },
    });

    const result = await handler.execute(incoming);

    expect(result.response).toBe("done");
    expect(result.resolved.modeKey).toBe("serious");
    expect(result.model).toBe("openai:gpt-4o-mini");
    expect(runnerModel).toBe("openai:gpt-4o-mini");
    expect(runnerPrompt).toBe("hello there");
    expect(runnerContextLength).toBeGreaterThan(0);

    await history.close();
  });

  it("returns help text for !h", async () => {
    const history = new ChatHistoryStore(":memory:", 40);
    await history.initialize();

    const incoming = makeMessage("!h");
    await history.addMessage(incoming);

    const handler = new RoomCommandHandlerTs({
      roomConfig: roomConfig as any,
      history,
      classifyMode: async () => "EASY_SERIOUS",
      runnerFactory: () => {
        throw new Error("runner should not be called for help");
      },
    });

    const result = await handler.execute(incoming);

    expect(result.response).toContain("default is");
    expect(result.resolved.helpRequested).toBe(true);

    await history.close();
  });
});
