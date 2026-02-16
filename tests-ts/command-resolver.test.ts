import { describe, expect, it } from "vitest";

import { CommandResolver } from "../src/rooms/command/resolver.js";

const commandConfig = {
  historySize: 40,
  defaultMode: "classifier:serious",
  channelModes: {
    "libera##sarcasm": "!d",
  },
  modes: {
    serious: {
      model: "openai:gpt-4o-mini",
      reasoningEffort: "low",
      steering: true,
      triggers: {
        "!s": {},
        "!a": {
          reasoningEffort: "medium",
        },
      },
    },
    sarcastic: {
      model: "anthropic:claude-3-5-haiku-20241022",
      reasoningEffort: "minimal",
      steering: false,
      triggers: {
        "!d": {},
      },
    },
  },
  modeClassifier: {
    model: "openai:gpt-4o-mini",
    labels: {
      EASY_SERIOUS: "!s",
      SARCASTIC: "!d",
    },
    fallbackLabel: "EASY_SERIOUS",
  },
} as const;

describe("CommandResolver", () => {
  it("parses prefix flags, mode token, model override, and query", () => {
    const resolver = new CommandResolver(
      commandConfig as any,
      async () => "EASY_SERIOUS",
      "!h",
      new Set(["!c"]),
      (model) => String(model),
    );

    const parsed = resolver.parsePrefix("!c !s @openai:gpt-4o explain it");

    expect(parsed.noContext).toBe(true);
    expect(parsed.modeToken).toBe("!s");
    expect(parsed.modelOverride).toBe("openai:gpt-4o");
    expect(parsed.queryText).toBe("explain it");
    expect(parsed.error).toBeNull();
  });

  it("returns parse error for unknown command token", () => {
    const resolver = new CommandResolver(
      commandConfig as any,
      async () => "EASY_SERIOUS",
      "!h",
      new Set(["!c"]),
      (model) => String(model),
    );

    const parsed = resolver.parsePrefix("!zzz hello");
    expect(parsed.error).toContain("Unknown command");
  });

  it("resolves explicit trigger command", async () => {
    const resolver = new CommandResolver(
      commandConfig as any,
      async () => "SARCASTIC",
      "!h",
      new Set(["!c"]),
      (model) => String(model),
    );

    const resolved = await resolver.resolve({
      message: {
        serverTag: "libera",
        channelName: "#test",
        nick: "user",
        mynick: "bot",
        content: "!a use deep reasoning",
      },
      context: [],
      defaultSize: 40,
    });

    expect(resolved.modeKey).toBe("serious");
    expect(resolved.selectedTrigger).toBe("!a");
    expect(resolved.runtime?.reasoningEffort).toBe("medium");
    expect(resolved.selectedAutomatically).toBe(false);
  });

  it("resolves classifier-constrained mode and clamps to configured mode", async () => {
    const resolver = new CommandResolver(
      commandConfig as any,
      async () => "SARCASTIC",
      "!h",
      new Set(["!c"]),
      (model) => String(model),
    );

    const resolved = await resolver.resolve({
      message: {
        serverTag: "libera",
        channelName: "#general",
        nick: "user",
        mynick: "bot",
        content: "tell me something",
      },
      context: [{ role: "user", content: "hello" }],
      defaultSize: 40,
    });

    expect(resolved.modeKey).toBe("serious");
    expect(resolved.selectedTrigger).toBe("!s");
    expect(resolved.selectedAutomatically).toBe(true);
  });

  it("supports steering bypass detection for non-steering mode", () => {
    const resolver = new CommandResolver(
      commandConfig as any,
      async () => "EASY_SERIOUS",
      "!h",
      new Set(["!c"]),
      (model) => String(model),
    );

    const bypass = resolver.shouldBypassSteering({
      serverTag: "libera",
      channelName: "#general",
      nick: "user",
      mynick: "bot",
      content: "!d be snarky",
    });

    expect(bypass).toBe(true);
  });
});
