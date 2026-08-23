import { describe, expect, it } from "vitest";

import { SessionLimits, createNudgeDecider } from "../src/agent/session-limits.js";

describe("SessionLimits", () => {
  const usage = (input: number, costTotal: number) => ({
    input,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { total: costTotal },
  });

  it("tracks peak (not cumulative) context and cumulative cost", () => {
    const limits = new SessionLimits(100_000, 1.0);
    limits.recordTurn(usage(60_000, 0.1), "toolUse");
    limits.recordTurn(usage(40_000, 0.1), "toolUse");
    expect(limits.reached).toBe(false);
    expect(limits.nearLimit).toBe(false);

    // Peak 60k + costs 0.2 — cheap turns push cumulative cost past 1.0 → reached via cost
    for (let i = 0; i < 9; i += 1) limits.recordTurn(usage(1_000, 0.1), "toolUse");
    expect(limits.reached).toBe(true);
  });

  it("reaches via peak context and reports nearLimit at 80%", () => {
    const limits = new SessionLimits(100_000, 1.0);
    limits.recordTurn(usage(85_000, 0.01), "stop");
    expect(limits.nearLimit).toBe(true);
    expect(limits.reached).toBe(false);
    limits.recordTurn(usage(100_000, 0.01), "stop");
    expect(limits.reached).toBe(true);
  });

  it("ignores turns without usage", () => {
    const limits = new SessionLimits(100, 0.01);
    limits.recordTurn(undefined, "toolUse");
    expect(limits.reached).toBe(false);
  });

  it("safety vent: aborts only after 10 post-limit toolUse turns", () => {
    const limits = new SessionLimits(100_000, 1.0);
    // Not at limit: toolUse turns never arm the vent.
    for (let i = 0; i < 20; i += 1) {
      expect(limits.recordTurn(usage(1_000, 0.001), "toolUse")).toBe(false);
    }
    // The limit-crossing toolUse turn itself counts as post-limit turn #1.
    expect(limits.recordTurn(usage(100_000, 0.001), "toolUse")).toBe(false);
    for (let i = 0; i < 8; i += 1) {
      expect(limits.recordTurn(usage(1_000, 0.001), "toolUse")).toBe(false);
    }
    // Post-limit toolUse turn #10 trips the vent.
    expect(limits.recordTurn(usage(1_000, 0.001), "toolUse")).toBe(true);
    // Non-toolUse turns past the vent threshold still request abort.
    expect(limits.recordTurn(usage(1_000, 0.001), "stop")).toBe(true);
  });

  it("bump re-arms the safety vent with a fresh 10-turn window", () => {
    const limits = new SessionLimits(100_000, 1.0);
    // Reach the limit and burn 9 of the 10 vent turns.
    limits.recordTurn(usage(100_000, 0), "toolUse");
    for (let i = 0; i < 8; i += 1) limits.recordTurn(usage(1_000, 0), "toolUse");

    limits.bump(0, 0); // floored to +10k tokens → unblocked, vent reset
    expect(limits.reached).toBe(false);

    // Reaching the ENLARGED ceiling grants a fresh window: turn #1, not #10.
    expect(limits.recordTurn(usage(120_000, 0), "toolUse")).toBe(false);
    for (let i = 0; i < 8; i += 1) {
      expect(limits.recordTurn(usage(1_000, 0), "toolUse")).toBe(false);
    }
    expect(limits.recordTurn(usage(1_000, 0), "toolUse")).toBe(true);
  });

  it("progress nudge asks for a status line only alongside further tool calls", () => {
    const limits = new SessionLimits(100_000, 1.0);
    const decider = createNudgeDecider(
      limits,
      Date.now() - 60_000,
      "high",
      { lastResponseAt: Date.now() - 60_000 },
      undefined,
      10,
    );
    const nudge = decider(1);
    expect(nudge).toBeTruthy();
    // Must make it explicit that a final answer carries no status/preamble line,
    // otherwise models glue the status line in front of the answer.
    expect(nudge).toMatch(/only the answer/iu);
    expect(nudge).toMatch(/no status line|without a status line/iu);
  });

  it("bump floors increments at 10% of the original limits", () => {
    const limits = new SessionLimits(100_000, 1.0);
    limits.recordTurn(usage(105_000, 0.001), "stop");
    expect(limits.reached).toBe(true);

    limits.bump(100, 0.001); // tiny → floored to 10_000 tokens / $0.1
    expect(limits.reached).toBe(false); // 105k < 110k

    limits.bump(50_000, 0.5); // above floor → taken verbatim
    limits.recordTurn(usage(159_000, 0), "stop");
    expect(limits.reached).toBe(false); // 159k < 160k
    // Floors stay anchored to the ORIGINAL limits, not the bumped ones.
    limits.bump(1, 0);
    limits.recordTurn(usage(169_000, 0), "stop");
    expect(limits.reached).toBe(false); // 169k < 170k
  });
});
