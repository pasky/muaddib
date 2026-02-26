import { describe, expect, it } from "vitest";

import { modelStrCore } from "../src/rooms/command/command-executor.js";
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
        arc: "libera##test",
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
        arc: "libera##general",
        nick: "user",
        mynick: "bot",
        content: "tell me something",
      },
      context: [{ role: "user" as const, content: "hello", timestamp: 0 }],
      defaultSize: 40,
    });

    expect(resolved.modeKey).toBe("serious");
    expect(resolved.selectedTrigger).toBe("!s");
    expect(resolved.selectedAutomatically).toBe(true);
  });

  it("buildHelpMessage groups triggers by effective model, splitting trigger-level model overrides", () => {
    const configWithModelOverride = {
      ...commandConfig,
      modes: {
        ...commandConfig.modes,
        serious: {
          ...commandConfig.modes.serious,
          triggers: {
            "!s": {},
            "!a": {
              reasoningEffort: "medium",
              model: "openrouter:google/gemini-pro",
            },
          },
        },
      },
    };

    const resolver = new CommandResolver(
      configWithModelOverride as any,
      async () => "EASY_SERIOUS",
      "!h",
      new Set(["!c"]),
      (model) => String(model),
    );

    const help = resolver.buildHelpMessage("libera", "#general");

    // !s and !a stay grouped with /, both models listed with /
    expect(help).toContain("!s/!a = serious (openai:gpt-4o-mini/openrouter:google/gemini-pro)");
  });

  it("buildHelpMessage groups triggers sharing the same effective model", () => {
    const resolver = new CommandResolver(
      commandConfig as any,
      async () => "EASY_SERIOUS",
      "!h",
      new Set(["!c"]),
      (model) => String(model),
    );

    const help = resolver.buildHelpMessage("libera", "#general");

    // !s and !a share the mode-default model (no model override on !a in base config)
    expect(help).toContain("!s/!a = serious");
    expect(help).not.toMatch(/!s = serious.*!a = serious/);
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
      arc: "libera##general",
      nick: "user",
      mynick: "bot",
      content: "!d be snarky",
    });

    expect(bypass).toBe(true);
  });

  it("resolves memoryUpdate from mode config (defaults true, respects false)", async () => {
    const configWithMemory = {
      ...commandConfig,
      modes: {
        ...commandConfig.modes,
        sarcastic: {
          ...commandConfig.modes.sarcastic,
          memoryUpdate: false,
        },
      },
    };

    const resolver = new CommandResolver(
      configWithMemory as any,
      async () => "EASY_SERIOUS",
      "!h",
      new Set(["!c"]),
      (model) => String(model),
    );

    // Serious mode defaults to true
    const serious = await resolver.resolve({
      message: { serverTag: "s", channelName: "#c", arc: "s##c", nick: "u", mynick: "b", content: "!s test" },
      context: [],
      defaultSize: 40,
    });
    expect(serious.runtime?.memoryUpdate).toBe(true);

    // Sarcastic mode explicitly set to false
    const sarcastic = await resolver.resolve({
      message: { serverTag: "s", channelName: "#c", arc: "s##c", nick: "u", mynick: "b", content: "!d test" },
      context: [],
      defaultSize: 40,
    });
    expect(sarcastic.runtime?.memoryUpdate).toBe(false);
  });

  it("buildHelpMessage strips provider slug from model names via modelStrCore", () => {
    const configWithSlug = {
      ...commandConfig,
      modes: {
        ...commandConfig.modes,
        serious: {
          ...commandConfig.modes.serious,
          model: "openrouter:kimi-k2.5#moonshotai/int4",
          triggers: {
            "!s": {},
            "!a": {
              reasoningEffort: "medium",
              model: "anthropic:claude-opus-4-6",
            },
          },
        },
      },
    };

    const resolver = new CommandResolver(
      configWithSlug as any,
      async () => "EASY_SERIOUS",
      "!h",
      new Set(["!c"]),
      modelStrCore,
    );

    const help = resolver.buildHelpMessage("libera", "#general");
    expect(help).toContain("!s/!a = serious (kimi-k2.5/claude-opus-4-6)");
  });
});

describe("modelStrCore", () => {
  it("strips provider prefix", () => {
    expect(modelStrCore("anthropic:claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  it("strips provider prefix and org path", () => {
    expect(modelStrCore("openrouter:google/gemini-pro")).toBe("gemini-pro");
  });

  it("strips provider slug after #", () => {
    expect(modelStrCore("openrouter:kimi-k2.5#moonshotai/int4")).toBe("kimi-k2.5");
  });

  it("handles bare model name", () => {
    expect(modelStrCore("claude-opus-4-6")).toBe("claude-opus-4-6");
  });
});
