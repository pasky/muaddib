import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { Usage } from "@mariozechner/pi-ai";

import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import {
  currentCostSpan,
  recordUsage,
  withCostSpan,
  withPersistedCostSpan,
} from "../src/cost/cost-span.js";
import { LLM_CALL_TYPE } from "../src/cost/llm-call-type.js";
import { UserCostLedger } from "../src/cost/user-cost-ledger.js";

function makeUsage(multiplier = 1): Usage {
  return {
    input: 10 * multiplier,
    output: 5 * multiplier,
    cacheRead: 2 * multiplier,
    cacheWrite: 1 * multiplier,
    totalTokens: 18 * multiplier,
    cost: {
      input: 0.01 * multiplier,
      output: 0.02 * multiplier,
      cacheRead: 0.003 * multiplier,
      cacheWrite: 0.001 * multiplier,
      total: 0.034 * multiplier,
    },
  };
}

describe("CostSpan", () => {
  it("builds a span tree, inherits attributes, and aggregates usage", async () => {
    await withCostSpan("execute", { arc: "libera##test", userArc: "libera#alice" }, async (root) => {
      recordUsage(LLM_CALL_TYPE.AGENT_RUN, "openai:gpt-4o-mini", makeUsage(1));

      await withCostSpan(LLM_CALL_TYPE.ORACLE, { trigger: "!s" }, async (child) => {
        expect(currentCostSpan()).toBe(child);
        expect(child.attributes).toMatchObject({
          arc: "libera##test",
          userArc: "libera#alice",
          trigger: "!s",
        });
        recordUsage(LLM_CALL_TYPE.ORACLE, "anthropic:claude-sonnet-4", makeUsage(2));
      });

      expect(root.children).toHaveLength(1);
      expect(root.children[0]?.name).toBe(LLM_CALL_TYPE.ORACLE);

      const entries = root.allEntries();
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.callType)).toEqual([LLM_CALL_TYPE.AGENT_RUN, LLM_CALL_TYPE.ORACLE]);
      expect(entries.map((entry) => entry.spanName)).toEqual(["execute", LLM_CALL_TYPE.ORACLE]);

      const total = root.totalUsage();
      expect(total.input).toBe(30);
      expect(total.output).toBe(15);
      expect(total.cacheRead).toBe(6);
      expect(total.cacheWrite).toBe(3);
      expect(total.totalTokens).toBe(54);
      expect(total.cost.total).toBeCloseTo(0.102);
    });

    expect(currentCostSpan()).toBeNull();
  });

  it("propagates the current span across async boundaries", async () => {
    let seenSpanName: string | null = null;

    await withCostSpan("execute", { arc: "libera##test" }, async (root) => {
      await Promise.resolve();

      await new Promise<void>((resolve) => {
        setTimeout(() => {
          seenSpanName = currentCostSpan()?.name ?? null;
          recordUsage(LLM_CALL_TYPE.AGENT_RUN, "openai:gpt-4o-mini", makeUsage(1));
          resolve();
        }, 0);
      });

      expect(root.allEntries()).toHaveLength(1);
      expect(root.allEntries()[0]?.callType).toBe(LLM_CALL_TYPE.AGENT_RUN);
    });

    expect(seenSpanName).toBe("execute");
  });

  it("persists history rows for all entries and charges user when userArc is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muaddib-cost-span-test-"));
    const history = new ChatHistoryStore(dir);
    const ledger = new UserCostLedger(dir);
    await history.initialize();

    try {
      await withPersistedCostSpan(
        "execute",
        {
          arc: "libera##test",
          userArc: "libera#alice",
          byok: true,
        },
        {
          history,
          run: "run-1",
          userCostLedger: ledger,
        },
        async () => {
          recordUsage(LLM_CALL_TYPE.MODE_CLASSIFIER, "openai:gpt-4o-mini", makeUsage(1));
          await withCostSpan(LLM_CALL_TYPE.ORACLE, {}, async () => {
            recordUsage(LLM_CALL_TYPE.ORACLE, "anthropic:claude-sonnet-4", makeUsage(2));
          });
        },
      );

      const today = new Date().toISOString().slice(0, 10);
      const historyFile = join(dir, "libera##test", "chat_history", `${today}.jsonl`);
      const historyRows = readFileSync(historyFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      expect(historyRows).toHaveLength(2);
      expect(historyRows.map((row) => row.call)).toEqual([LLM_CALL_TYPE.MODE_CLASSIFIER, LLM_CALL_TYPE.ORACLE]);
      expect(historyRows.every((row) => row.run === "run-1")).toBe(true);
      expect(historyRows.every((row) => row.source === "execute")).toBe(true);

      const ledgerFile = join(dir, "users", "libera#alice", "cost", `${today}.jsonl`);
      const ledgerRows = readFileSync(ledgerFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      expect(ledgerRows).toHaveLength(2);
      expect(ledgerRows[0]).toMatchObject({
        byok: true,
        arc: "libera##test",
        model: "openai:gpt-4o-mini",
      });
      expect(ledgerRows[0].cost).toBeCloseTo(0.034);
      expect(ledgerRows[1]).toMatchObject({
        byok: true,
        arc: "libera##test",
        model: "anthropic:claude-sonnet-4",
      });
      expect(ledgerRows[1].cost).toBeCloseTo(0.068);
    } finally {
      await history.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
