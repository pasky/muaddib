import { describe, expect, it } from "vitest";

import type { Usage } from "@earendil-works/pi-ai";

import { SessionLimits, createNudgeDecider } from "../src/agent/session-limits.js";

describe("SessionLimits", () => {
  const usage = (input: number, costTotal: number): Usage => ({
    input,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 10,
    cost: { input: costTotal, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  });
  /** One assistant turn: its LLM call's usage, then the turn boundary. */
  const turn = (limits: SessionLimits, u: Usage | undefined, stopReason: "toolUse" | "stop"): boolean => {
    if (u) limits.recordUsage(u);
    return limits.recordTurnEnd(stopReason);
  };

  it("hands over billed usage since the previous take, without touching the ceilings", () => {
    const limits = new SessionLimits(100_000, 1.0);
    turn(limits, usage(1_000, 0.02), "toolUse");
    // A compaction summarization is an LLM call without a turn boundary.
    limits.recordUsage(usage(4_000, 0.03));

    const mainRun = limits.takeUsage();
    expect(mainRun.usage.cost.total).toBeCloseTo(0.05, 5);
    expect(mainRun.usage.input).toBe(5_000);
    expect(mainRun.usage.totalTokens).toBe(5_020);
    expect(mainRun.peakTurnInput).toBe(4_000);

    // A follow-up prompt on the same session gets exactly its own share ...
    turn(limits, usage(2_000, 0.5), "stop");
    const followUp = limits.takeUsage();
    expect(followUp.usage.cost.total).toBeCloseTo(0.5, 5);
    expect(followUp.usage.input).toBe(2_000);
    expect(followUp.peakTurnInput).toBe(2_000);
    // ... while the take already handed out is untouched.
    expect(mainRun.usage.cost.total).toBeCloseTo(0.05, 5);

    // Nothing new since the last take.
    expect(limits.takeUsage().usage.cost.total).toBe(0);

    // The ceilings still see the cumulative picture: $0.55 of $1 is near the limit.
    expect(limits.nearLimit).toBe(false);
    turn(limits, usage(1_000, 0.3), "stop");
    expect(limits.nearLimit).toBe(true);
    expect(limits.reached).toBe(false);
  });

  it("tracks peak (not cumulative) context and cumulative cost", () => {
    const limits = new SessionLimits(100_000, 1.0);
    turn(limits, usage(60_000, 0.1), "toolUse");
    turn(limits, usage(40_000, 0.1), "toolUse");
    expect(limits.reached).toBe(false);
    expect(limits.nearLimit).toBe(false);

    // Peak 60k + costs 0.2 — cheap turns push cumulative cost past 1.0 → reached via cost
    for (let i = 0; i < 9; i += 1) turn(limits, usage(1_000, 0.1), "toolUse");
    expect(limits.reached).toBe(true);
  });

  it("reaches via peak context and reports nearLimit at 80%", () => {
    const limits = new SessionLimits(100_000, 1.0);
    turn(limits, usage(85_000, 0.01), "stop");
    expect(limits.nearLimit).toBe(true);
    expect(limits.reached).toBe(false);
    turn(limits, usage(100_000, 0.01), "stop");
    expect(limits.reached).toBe(true);
  });

  it("ignores turns without usage", () => {
    const limits = new SessionLimits(100, 0.01);
    turn(limits, undefined, "toolUse");
    expect(limits.reached).toBe(false);
  });

  it("safety vent: aborts only after 10 post-limit toolUse turns", () => {
    const limits = new SessionLimits(100_000, 1.0);
    // Not at limit: toolUse turns never arm the vent.
    for (let i = 0; i < 20; i += 1) {
      expect(turn(limits, usage(1_000, 0.001), "toolUse")).toBe(false);
    }
    // The limit-crossing toolUse turn itself counts as post-limit turn #1.
    expect(turn(limits, usage(100_000, 0.001), "toolUse")).toBe(false);
    for (let i = 0; i < 8; i += 1) {
      expect(turn(limits, usage(1_000, 0.001), "toolUse")).toBe(false);
    }
    // Post-limit toolUse turn #10 trips the vent.
    expect(turn(limits, usage(1_000, 0.001), "toolUse")).toBe(true);
    // Non-toolUse turns past the vent threshold still request abort.
    expect(turn(limits, usage(1_000, 0.001), "stop")).toBe(true);
  });

  it("bump re-arms the safety vent with a fresh 10-turn window", () => {
    const limits = new SessionLimits(100_000, 1.0);
    // Reach the limit and burn 9 of the 10 vent turns.
    turn(limits, usage(100_000, 0), "toolUse");
    for (let i = 0; i < 8; i += 1) turn(limits, usage(1_000, 0), "toolUse");

    limits.bump(0, 0); // floored to +10k tokens → unblocked, vent reset
    expect(limits.reached).toBe(false);

    // Reaching the ENLARGED ceiling grants a fresh window: turn #1, not #10.
    expect(turn(limits, usage(120_000, 0), "toolUse")).toBe(false);
    for (let i = 0; i < 8; i += 1) {
      expect(turn(limits, usage(1_000, 0), "toolUse")).toBe(false);
    }
    expect(turn(limits, usage(1_000, 0), "toolUse")).toBe(true);
  });

  it("progress nudge asks for a machine-readable <status> tag alongside further tool calls", () => {
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
    // The tag is what lets the runner drop a status line the model glued onto
    // its final answer; plain prose instructions alone are not enforceable.
    expect(nudge).toContain("<status>");
    expect(nudge).toContain("</status>");
  });

  it("bump floors increments at 10% of the original limits", () => {
    const limits = new SessionLimits(100_000, 1.0);
    turn(limits, usage(105_000, 0.001), "stop");
    expect(limits.reached).toBe(true);

    limits.bump(100, 0.001); // tiny → floored to 10_000 tokens / $0.1
    expect(limits.reached).toBe(false); // 105k < 110k

    limits.bump(50_000, 0.5); // above floor → taken verbatim
    turn(limits, usage(159_000, 0), "stop");
    expect(limits.reached).toBe(false); // 159k < 160k
    // Floors stay anchored to the ORIGINAL limits, not the bumped ones.
    limits.bump(1, 0);
    turn(limits, usage(169_000, 0), "stop");
    expect(limits.reached).toBe(false); // 169k < 170k
  });
});
