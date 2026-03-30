import { describe, expect, it } from "vitest";

import { accumulateUsage, sumAssistantUsage } from "../src/cost/usage.js";

describe("cost/usage", () => {
  it("accumulateUsage mutates target field-by-field", () => {
    const target = {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
    };
    const source = {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    };

    expect(accumulateUsage(target as any, source as any)).toBe(target);
    expect(target).toEqual({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      totalTokens: 110,
      cost: { input: 1.1, output: 2.2, cacheRead: 3.3, cacheWrite: 4.4, total: 11 },
    });
  });

  it("sums assistant usage and peak single-turn input", () => {
    const result = sumAssistantUsage([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "text", text: "one" }],
        usage: {
          input: 5,
          output: 2,
          cacheRead: 1,
          cacheWrite: 0,
          totalTokens: 8,
          cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
        },
        stopReason: "stop",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "two" }],
        usage: {
          input: 3,
          output: 4,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 10,
          cost: { input: 0.03, output: 0.04, cacheRead: 0.002, cacheWrite: 0.001, total: 0.073 },
        },
        stopReason: "stop",
      },
    ] as any);

    expect(result.usage.totalTokens).toBe(18);
    expect(result.usage.cost.total).toBeCloseTo(0.104);
    expect(result.peakTurnInput).toBe(6);
  });
});
