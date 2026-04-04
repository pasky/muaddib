import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkUserBudget,
  resolveCostPolicyConfig,
  shouldEmitQuotaWarning,
  readQuotaWarningTs,
  applyUserPolicyOverride,
} from "../src/cost/cost-policy.js";
import { remapToOpenRouter } from "../src/cost/model-remap.js";
import { resolveProviderOverrideModel } from "../src/models/provider-overrides.js";
import { LLM_CALL_TYPE, isLlmCallType } from "../src/cost/llm-call-type.js";
import { UserCostLedger } from "../src/cost/user-cost-ledger.js";
import { UserKeyStore } from "../src/cost/user-key-store.js";
import { UserPolicyStore } from "../src/cost/user-policy-store.js";
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

describe("resolveProviderOverrideModel normalizes version separators", () => {
  it("resolves anthropic/claude-opus-4-6 via dot normalization", () => {
    // The static registry has "anthropic/claude-opus-4.6" (with dot),
    // but BYOK remap produces "anthropic/claude-opus-4-6" (with hyphen).
    const model = resolveProviderOverrideModel("openrouter", "anthropic/claude-opus-4-6");
    expect(model).toBeDefined();
    expect(model!.id).toBe("anthropic/claude-opus-4.6");
  });

  it("resolves exact match without normalization", () => {
    const model = resolveProviderOverrideModel("openrouter", "anthropic/claude-opus-4.6");
    expect(model).toBeDefined();
    expect(model!.id).toBe("anthropic/claude-opus-4.6");
  });

  it("does not mangle non-version hyphens", () => {
    // gpt-4o-mini has no digit-hyphen-digit, so normalization is a no-op
    const model = resolveProviderOverrideModel("openrouter", "openai/gpt-4o-mini");
    expect(model).toBeDefined();
    expect(model!.id).toBe("openai/gpt-4o-mini");
  });
});

describe("resolveCostPolicyConfig", () => {
  it("returns null when costPolicy is undefined or has no explicit budget", () => {
    expect(resolveCostPolicyConfig(undefined)).toBeNull();
    expect(resolveCostPolicyConfig({})).toBeNull();
    expect(resolveCostPolicyConfig({ freeTierWindowHours: 24 })).toBeNull();
  });

  it("resolves when freeTierBudgetUsd is explicitly set", () => {
    expect(resolveCostPolicyConfig({ freeTierBudgetUsd: 3 })).toEqual({
      freeTierBudgetUsd: 3,
      freeTierWindowHours: 72,
    });
    expect(resolveCostPolicyConfig({ freeTierBudgetUsd: 5, freeTierWindowHours: 24 })).toEqual({
      freeTierBudgetUsd: 5,
      freeTierWindowHours: 24,
    });
  });
});

describe("LLM call types", () => {
  it("defines all canonical call types with a working type guard", () => {
    for (const value of Object.values(LLM_CALL_TYPE)) {
      expect(isLlmCallType(value)).toBe(true);
    }
    expect(isLlmCallType("nonexistent")).toBe(false);
    expect(LLM_CALL_TYPE.GENERATE_IMAGE).toBe("generate_image");
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

describe("shouldEmitQuotaWarning", () => {
  it("does not fire below 90% usage", () => {
    const home = makeTempHome();
    try {
      expect(shouldEmitQuotaWarning(home, "libera#alice", 0.89, 72)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fires at 90%+ and persists cooldown timestamp", () => {
    const home = makeTempHome();
    try {
      const now = new Date("2026-03-30T12:00:00Z");
      expect(shouldEmitQuotaWarning(home, "libera#alice", 0.92, 72, now)).toBe(true);

      const ts = readQuotaWarningTs(join(home, "users", "libera#alice", "quota-warning.json"));
      expect(ts).toBe(now.getTime());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("respects cooldown period (5% of window)", () => {
    const home = makeTempHome();
    try {
      const t0 = new Date("2026-03-30T12:00:00Z");
      expect(shouldEmitQuotaWarning(home, "libera#alice", 0.95, 72, t0)).toBe(true);

      // 1h later — within 3.6h cooldown
      const t1 = new Date("2026-03-30T13:00:00Z");
      expect(shouldEmitQuotaWarning(home, "libera#alice", 0.96, 72, t1)).toBe(false);

      // 4h later — past 3.6h cooldown
      const t2 = new Date("2026-03-30T16:00:00Z");
      expect(shouldEmitQuotaWarning(home, "libera#alice", 0.97, 72, t2)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("UserKeyStore", () => {
  it("throws on corrupt auth.json", () => {
    const muaddibHome = makeTempHome();
    const userArc = buildArc("libera", "alice");
    const keyStore = new UserKeyStore(muaddibHome);

    try {
      const authDir = join(muaddibHome, "users", userArc);
      mkdirSync(authDir, { recursive: true });
      writeFileSync(join(authDir, "auth.json"), '{"openrouter": {"type": "api_key", "key": "x"}');

      expect(() => keyStore.getOpenRouterKey(userArc)).toThrow(/Failed to load/);
    } finally {
      rmSync(muaddibHome, { recursive: true, force: true });
    }
  });
});

describe("UserPolicyStore", () => {
  it("returns false for exempt when no policy.json exists", () => {
    const home = makeTempHome();
    try {
      const store = new UserPolicyStore(home);
      expect(store.isExempt("libera#alice")).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads exempt from policy.json", () => {
    const home = makeTempHome();
    const userArc = "libera#alice";
    try {
      const dir = join(home, "users", userArc);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "policy.json"), JSON.stringify({ exempt: true }));
      const store = new UserPolicyStore(home);
      expect(store.isExempt(userArc)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads budget overrides from policy.json", () => {
    const home = makeTempHome();
    const userArc = "libera#alice";
    try {
      const dir = join(home, "users", userArc);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "policy.json"), JSON.stringify({ freeTierBudgetUsd: 10, freeTierWindowHours: 48 }));
      const store = new UserPolicyStore(home);
      expect(store.getBudgetOverride(userArc)).toEqual({ freeTierBudgetUsd: 10, freeTierWindowHours: 48 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns null for budget override on empty object", () => {
    const home = makeTempHome();
    const userArc = "libera#alice";
    try {
      const dir = join(home, "users", userArc);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "policy.json"), "{}");
      const store = new UserPolicyStore(home);
      expect(store.getBudgetOverride(userArc)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws on invalid freeTierBudgetUsd", () => {
    const home = makeTempHome();
    const userArc = "libera#alice";
    try {
      const dir = join(home, "users", userArc);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "policy.json"), JSON.stringify({ freeTierBudgetUsd: -1 }));
      const store = new UserPolicyStore(home);
      expect(() => store.getBudgetOverride(userArc)).toThrow(/freeTierBudgetUsd/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws on non-boolean exempt", () => {
    const home = makeTempHome();
    const userArc = "libera#alice";
    try {
      const dir = join(home, "users", userArc);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "policy.json"), JSON.stringify({ exempt: "yes" }));
      const store = new UserPolicyStore(home);
      expect(() => store.isExempt(userArc)).toThrow(/exempt must be a boolean/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("checkUserBudget", () => {
  it("returns byok and exempt states before validating free-tier policy", async () => {
    const muaddibHome = makeTempHome();
    const userArc = buildArc("libera", "alice");
    const keyStore = new UserKeyStore(muaddibHome);
    const policyStore = new UserPolicyStore(muaddibHome);
    const ledger = new UserCostLedger(muaddibHome);

    try {
      keyStore.setOpenRouterKey(userArc, "sk-or-v1-user");
      await expect(checkUserBudget({
        costPolicy: { freeTierBudgetUsd: -1 },
        userArc,
        keyStore,
        policyStore,
        ledger,
      })).resolves.toMatchObject({
        allowed: true,
        state: "byok",
        openRouterKey: "sk-or-v1-user",
      });

      keyStore.clearOpenRouterKey(userArc);
      const policyDir = join(muaddibHome, "users", userArc);
      mkdirSync(policyDir, { recursive: true });
      writeFileSync(join(policyDir, "policy.json"), JSON.stringify({ exempt: true }));
      await expect(checkUserBudget({
        costPolicy: { freeTierWindowHours: 0 },
        userArc,
        keyStore,
        policyStore,
        ledger,
      })).resolves.toMatchObject({
        allowed: true,
        state: "exempt",
      });
    } finally {
      rmSync(muaddibHome, { recursive: true, force: true });
    }
  });

  it("uses per-user policy.json overrides over global costPolicy", async () => {
    const muaddibHome = makeTempHome();
    const userArc = buildArc("libera", "alice");
    const keyStore = new UserKeyStore(muaddibHome);
    const policyStore = new UserPolicyStore(muaddibHome);
    const ledger = new UserCostLedger(muaddibHome);
    const now = new Date("2026-03-30T15:00:00Z");

    try {
      // Log $1.50 of spending
      await ledger.logUserCost(userArc, {
        ts: "2026-03-30T10:00:00Z",
        cost: 1.5,
        byok: false,
        arc: buildArc("libera", "#test"),
        model: "openai:gpt-4o-mini",
      });

      // Global policy: $1.00 budget → over budget
      const overBudget = await checkUserBudget({
        costPolicy: { freeTierBudgetUsd: 1.0, freeTierWindowHours: 72 },
        userArc,
        keyStore,
        policyStore,
        ledger,
        now,
      });
      expect(overBudget.state).toBe("over_budget");
      expect(overBudget.allowed).toBe(false);

      // Write per-user policy with higher budget → allowed
      const policyDir = join(muaddibHome, "users", userArc);
      mkdirSync(policyDir, { recursive: true });
      writeFileSync(
        join(policyDir, "policy.json"),
        JSON.stringify({ freeTierBudgetUsd: 5.0 }),
      );

      const allowed = await checkUserBudget({
        costPolicy: { freeTierBudgetUsd: 1.0, freeTierWindowHours: 72 },
        userArc,
        keyStore,
        policyStore,
        ledger,
        now,
      });
      expect(allowed.state).toBe("free");
      expect(allowed.allowed).toBe(true);
      expect(allowed.budget).toBe(5.0);
      expect(allowed.windowHours).toBe(72);
    } finally {
      rmSync(muaddibHome, { recursive: true, force: true });
    }
  });

  it("per-user policy.json can override windowHours independently", async () => {
    const muaddibHome = makeTempHome();
    const userArc = buildArc("libera", "bob");
    const keyStore = new UserKeyStore(muaddibHome);
    const policyStore = new UserPolicyStore(muaddibHome);
    const ledger = new UserCostLedger(muaddibHome);
    const now = new Date("2026-03-30T15:00:00Z");

    try {
      // Log $0.50 spending 25h ago
      await ledger.logUserCost(userArc, {
        ts: "2026-03-29T14:00:00Z",
        cost: 0.5,
        byok: false,
        arc: buildArc("libera", "#test"),
        model: "openai:gpt-4o-mini",
      });

      // Global: 72h window → spending visible, over budget
      const global72h = await checkUserBudget({
        costPolicy: { freeTierBudgetUsd: 0.4, freeTierWindowHours: 72 },
        userArc,
        keyStore,
        policyStore,
        ledger,
        now,
      });
      expect(global72h.state).toBe("over_budget");

      // Per-user override: 24h window → spending outside window
      const policyDir = join(muaddibHome, "users", userArc);
      mkdirSync(policyDir, { recursive: true });
      writeFileSync(
        join(policyDir, "policy.json"),
        JSON.stringify({ freeTierWindowHours: 24 }),
      );

      const narrow = await checkUserBudget({
        costPolicy: { freeTierBudgetUsd: 0.4, freeTierWindowHours: 72 },
        userArc,
        keyStore,
        policyStore,
        ledger,
        now,
      });
      expect(narrow.state).toBe("free");
      expect(narrow.windowHours).toBe(24);
    } finally {
      rmSync(muaddibHome, { recursive: true, force: true });
    }
  });
});

describe("applyUserPolicyOverride", () => {
  it("returns global when override is null", () => {
    const global = { freeTierBudgetUsd: 2, freeTierWindowHours: 72 };
    expect(applyUserPolicyOverride(global, null)).toBe(global);
  });

  it("selectively overrides fields", () => {
    const global = { freeTierBudgetUsd: 2, freeTierWindowHours: 72 };
    expect(applyUserPolicyOverride(global, { freeTierBudgetUsd: 10 })).toEqual({
      freeTierBudgetUsd: 10,
      freeTierWindowHours: 72,
    });
  });
});
