import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import {
  checkUserBudget,
  resolveCostPolicyConfig,
} from "../src/cost/cost-policy.js";
import { remapToOpenRouter } from "../src/cost/model-remap.js";
import { UserCostLedger } from "../src/cost/user-cost-ledger.js";
import { UserKeyStore } from "../src/cost/user-key-store.js";
import { buildArc } from "../src/rooms/message.js";

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "muaddib-cost-test-"));
}

describe("remapToOpenRouter", () => {
  it("remaps provider:model specs to OpenRouter equivalents", () => {
    expect(remapToOpenRouter("anthropic:claude-sonnet-4")).toBe(
      "openrouter:anthropic/claude-sonnet-4",
    );
    expect(remapToOpenRouter("openai:gpt-4o-mini")).toBe(
      "openrouter:openai/gpt-4o-mini",
    );
  });

  it("leaves OpenRouter specs unchanged", () => {
    expect(remapToOpenRouter("openrouter:anthropic/claude-sonnet-4")).toBe(
      "openrouter:anthropic/claude-sonnet-4",
    );
  });
});

describe("resolveCostPolicyConfig", () => {
  it("applies defaults only when costPolicy exists", () => {
    expect(resolveCostPolicyConfig(undefined)).toBeNull();
    expect(resolveCostPolicyConfig({ freeTierBudgetUsd: 3 })).toEqual({
      freeTierBudgetUsd: 3,
      freeTierWindowHours: 72,
    });
    expect(resolveCostPolicyConfig({ freeTierWindowHours: 24 })).toEqual({
      freeTierBudgetUsd: 2,
      freeTierWindowHours: 24,
    });
  });
});

describe("UserCostLedger", () => {
  it("stores rows in per-day files and queries rolling-window cost across dates", async () => {
    const muaddibHome = makeTempHome();
    const ledger = new UserCostLedger(muaddibHome);
    const userArc = buildArc("libera", "alice");
    const now = new Date("2026-03-30T15:00:00Z");

    try {
      await ledger.logUserCost(userArc, {
        ts: "2026-03-27T14:59:59Z",
        cost: 0.4,
        byok: false,
        arc: buildArc("libera", "#test"),
        model: "openai:gpt-4o-mini",
      });
      await ledger.logUserCost(userArc, {
        ts: "2026-03-27T15:00:00Z",
        cost: 0.6,
        byok: false,
        arc: buildArc("libera", "#test"),
        model: "openai:gpt-4o-mini",
      });
      await ledger.logUserCost(userArc, {
        ts: "2026-03-29T10:00:00Z",
        cost: 1.2,
        byok: true,
        arc: buildArc("libera", "#ops"),
        model: "openrouter:openai/gpt-4o-mini",
      });

      expect(readFileSync(join(muaddibHome, "users", userArc, "cost", "2026-03-27.jsonl"), "utf-8")).toContain(
        '"cost":0.6',
      );
      expect(readFileSync(join(muaddibHome, "users", userArc, "cost", "2026-03-29.jsonl"), "utf-8")).toContain(
        '"byok":true',
      );

      await expect(ledger.getUserCostInWindow(userArc, 72, { now })).resolves.toBeCloseTo(1.8);
      await expect(ledger.getUserCostInWindow(userArc, 72, { now, byok: false })).resolves.toBeCloseTo(0.6);
      await expect(ledger.getUserCostInWindow(userArc, 72, { now, byok: true })).resolves.toBeCloseTo(1.2);
    } finally {
      rmSync(muaddibHome, { recursive: true, force: true });
    }
  });
});

describe("checkUserBudget", () => {
  it("returns byok and exempt states before validating free-tier policy", async () => {
    const muaddibHome = makeTempHome();
    const userArc = buildArc("libera", "alice");
    const keyStore = new UserKeyStore(muaddibHome);
    const ledger = new UserCostLedger(muaddibHome);

    try {
      keyStore.setOpenRouterKey(userArc, "sk-or-v1-user");
      await expect(checkUserBudget({
        costPolicy: { freeTierBudgetUsd: -1 },
        userArc,
        keyStore,
        ledger,
      })).resolves.toMatchObject({
        allowed: true,
        state: "byok",
        openRouterKey: "sk-or-v1-user",
      });

      keyStore.clearOpenRouterKey(userArc);
      AuthStorage.create(join(muaddibHome, "users", userArc, "auth.json")).set("exempt", {
        type: "api_key",
        key: "true",
      });
      await expect(checkUserBudget({
        costPolicy: { freeTierWindowHours: 0 },
        userArc,
        keyStore,
        ledger,
      })).resolves.toMatchObject({
        allowed: true,
        state: "exempt",
      });
    } finally {
      rmSync(muaddibHome, { recursive: true, force: true });
    }
  });
});
