import { describe, expect, it } from "vitest";

import {
  applyPromptVariant,
  canonicalizeSystemPrompt,
  classifyDecision,
  extractExample,
  parseLlmIoBlocks,
  sampleDataset,
  type DatasetExample,
} from "../scripts/proactive-backtest/lib.js";

const SYSTEM = "You are IRC user MuaddibLLM. Persona stuff here. Current time: 2026-07-01 23:18 UTC. NOTE: This is a proactive interjection. Respond NULL when unsure!\n\nFilesystem: $HOME=/workspace blah\n<memory>secret workspace noise</memory>";

function logFor(opts: { delivered?: string; responseText?: string; thinking?: string; extraModel?: string }): string {
  const payload = {
    model: "claude-opus-4-5",
    messages: [
      { role: "user", content: "[13:41] <caster> is btrfs stable yet?" },
      { role: "assistant", content: [{ type: "text", text: "[13:42] <MuaddibLLM> define stable :)" }] },
      { role: "user", content: [{ type: "text", text: "[13:45] <kdave> depends on the raid level", cache_control: { type: "ephemeral" } }] },
    ],
    system: [{ type: "text", text: SYSTEM }],
  };
  const content: Array<Record<string, string>> = [];
  if (opts.thinking) content.push({ type: "thinking", thinking: opts.thinking });
  if (opts.responseText) content.push({ type: "text", text: opts.responseText });
  const response = { role: "assistant", content, model: "claude-opus-4-5", stopReason: "stop" };
  const lines = [
    "2026-07-16 22:52:53,098 - muaddib.rooms.command.irc - INFO - Interjecting proactively arc=libera##retwin lastMessage=x reason=Interjection decision (Final Score: 9)",
    "2026-07-16 22:52:53,099 - muaddib.rooms.command.irc - DEBUG - llm_io payload agent_stream " + JSON.stringify(payload, null, 2),
    "2026-07-16 22:52:55,000 - muaddib.rooms.command.irc - DEBUG - llm_io response agent_stream " + JSON.stringify(response, null, 2),
  ];
  if (opts.extraModel) {
    lines.push("2026-07-16 22:52:55,500 - muaddib.rooms.command.irc - DEBUG - llm_io payload agent_stream " + JSON.stringify({ ...payload, model: opts.extraModel }, null, 2));
  }
  if (opts.delivered) {
    lines.push(`2026-07-16 22:52:56,000 - muaddib.rooms.command.irc - INFO - Delivering response arc=libera##retwin response=${opts.delivered}`);
  }
  return lines.join("\n");
}

describe("parseLlmIoBlocks", () => {
  it("parses payload and response blocks with call types", () => {
    const blocks = parseLlmIoBlocks(logFor({ responseText: "NULL" }));
    expect(blocks.map((b) => [b.kind, b.callType])).toEqual([
      ["payload", "agent_stream"],
      ["response", "agent_stream"],
    ]);
    expect(blocks[0].json.model).toBe("claude-opus-4-5");
  });
});

describe("extractExample", () => {
  it("labels delivered responses as interject and strips workspace noise from system prompt", () => {
    const { example, skip } = extractExample(logFor({ delivered: "[claude-opus-4-5] kdave: raid5/6 still has the write hole" }), "d1");
    expect(skip).toBeUndefined();
    expect(example).toMatchObject({
      id: "d1",
      arc: "libera##retwin",
      label: "interject",
      silverModel: "claude-opus-4-5",
      deliveredSnippet: "[claude-opus-4-5] kdave: raid5/6 still has the write hole",
    });
    expect(example!.systemPrompt).toContain("NOTE: This is a proactive interjection");
    expect(example!.systemPrompt).not.toContain("Filesystem:");
    expect(example!.messages).toEqual([
      { role: "user", text: "[13:41] <caster> is btrfs stable yet?" },
      { role: "assistant", text: "[13:42] <MuaddibLLM> define stable :)" },
      { role: "user", text: "[13:45] <kdave> depends on the raid level" },
    ]);
  });

  it("labels explicit NULL responses as null (ignoring thinking blocks)", () => {
    const { example } = extractExample(logFor({ thinking: "not a question, staying quiet", responseText: "NULL" }), "n1");
    expect(example!.label).toBe("null");
  });

  it("skips sessions with neither delivery nor explicit NULL", () => {
    const { example, skip } = extractExample(logFor({ responseText: "" }), "a1");
    expect(example).toBeUndefined();
    expect(skip).toEqual({ id: "a1", reason: "no-delivery-no-explicit-null" });
  });

  it("skips logs without the interjecting marker", () => {
    expect(extractExample("some unrelated log", "x1").skip?.reason).toBe("no-interjecting-marker");
  });

  it("skips sessions where a refusal fallback switched models mid-decision", () => {
    const { example, skip } = extractExample(
      logFor({ delivered: "[deepseek-v4-pro] something", extraModel: "deepseek-v4-pro" }),
      "m1",
    );
    expect(example).toBeUndefined();
    expect(skip?.reason).toBe("mixed-models-claude-opus-4-5+deepseek-v4-pro");
  });
});

describe("canonicalizeSystemPrompt / applyPromptVariant", () => {
  it("replaces the NOTE tail with a variant", () => {
    const canonical = canonicalizeSystemPrompt(SYSTEM);
    const out = applyPromptVariant(canonical, "NOTE: new proactive rules.");
    expect(out).toBe("You are IRC user MuaddibLLM. Persona stuff here. Current time: 2026-07-01 23:18 UTC. NOTE: new proactive rules.");
  });

  it("throws when the NOTE marker is missing", () => {
    expect(() => applyPromptVariant("no marker here", "x")).toThrow(/NOTE marker/);
  });
});

describe("classifyDecision", () => {
  it("classifies NULL sentinel (with thinking and quotes) as null", () => {
    expect(classifyDecision({ text: "<thinking>meh</thinking>\n'NULL'", stopReason: "stop" }).decision).toBe("null");
    expect(classifyDecision({ text: "", stopReason: "stop" }).decision).toBe("null");
  });

  it("classifies real content as interject, stripping trailing NULL", () => {
    const r = classifyDecision({ text: "kdave: raid5 write hole is still a thing\nNULL", stopReason: "stop" });
    expect(r.decision).toBe("interject");
    expect(r.text).toBe("kdave: raid5 write hole is still a thing");
  });

  it("classifies refusal signals in body and error as refusal", () => {
    expect(classifyDecision({ text: "Content safety refusal", stopReason: "stop" }).decision).toBe("refusal");
    expect(classifyDecision({
      text: "",
      stopReason: "error",
      errorMessage: "the model refused to complete the request",
    }).decision).toBe("refusal");
  });

  it("classifies other errors as error", () => {
    expect(classifyDecision({ text: "", stopReason: "error", errorMessage: "429 too many requests" }).decision).toBe("error");
  });

  it("classifies Error:-prefixed output as error (production suppresses it)", () => {
    expect(classifyDecision({ text: "Error: tool exploded", stopReason: "stop" }).decision).toBe("error");
  });
});

describe("sampleDataset", () => {
  const examples: DatasetExample[] = Array.from({ length: 20 }, (_, i) => ({
    id: `ex${i}`,
    arc: "a",
    label: i % 2 === 0 ? "interject" : "null",
    silverModel: "m",
    systemPrompt: "s",
    messages: [],
    agentStreamCount: 1,
  }));

  it("caps per label deterministically and yields nested subsets", () => {
    const small = sampleDataset(examples, { null: 3, interject: 2 });
    expect(small.filter((e) => e.label === "null")).toHaveLength(3);
    expect(small.filter((e) => e.label === "interject")).toHaveLength(2);
    const big = sampleDataset(examples, { null: 6, interject: 4 });
    const bigIds = new Set(big.map((e) => e.id));
    for (const e of small) expect(bigIds.has(e.id)).toBe(true);
    expect(sampleDataset(examples, { null: 3, interject: 2 })).toEqual(small);
  });

  it("takes everything when no cap is given", () => {
    expect(sampleDataset(examples, {})).toHaveLength(20);
  });
});
