import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import type { CostPolicyConfig } from "../config/muaddib-config.js";
import { UserCostLedger } from "./user-cost-ledger.js";
import { UserKeyStore } from "./user-key-store.js";
import { UserPolicyStore, type UserPolicyOverride } from "./user-policy-store.js";

export type { UserPolicyOverride } from "./user-policy-store.js";

export type UserBudgetState = "byok" | "exempt" | "free" | "over_budget";

export interface UserBudgetStatus {
  allowed: boolean;
  state: UserBudgetState;
  remaining?: number;
  openRouterKey?: string;
  spent?: number;
  budget?: number;
  windowHours?: number;
  /** Fraction of budget used (0..1+), set for free/over_budget states when policy exists. */
  usageFraction?: number;
}

export interface ResolvedCostPolicyConfig {
  freeTierBudgetUsd: number;
  freeTierWindowHours: number;
}

export interface CheckUserBudgetInput {
  costPolicy?: CostPolicyConfig;
  userArc: string;
  keyStore: UserKeyStore;
  policyStore: UserPolicyStore;
  ledger: UserCostLedger;
  now?: Date;
}

export function resolveCostPolicyConfig(
  config: CostPolicyConfig | undefined,
): ResolvedCostPolicyConfig | null {
  if (config === undefined || config.freeTierBudgetUsd === undefined) {
    return null;
  }

  const freeTierBudgetUsd = config.freeTierBudgetUsd;
  if (typeof freeTierBudgetUsd !== "number" || !Number.isFinite(freeTierBudgetUsd) || freeTierBudgetUsd < 0) {
    throw new Error("costPolicy.freeTierBudgetUsd must be a finite number >= 0.");
  }

  const freeTierWindowHours = config.freeTierWindowHours ?? 72;
  if (
    typeof freeTierWindowHours !== "number" ||
    !Number.isFinite(freeTierWindowHours) ||
    freeTierWindowHours <= 0
  ) {
    throw new Error("costPolicy.freeTierWindowHours must be a finite number > 0.");
  }

  return {
    freeTierBudgetUsd,
    freeTierWindowHours,
  };
}

export function applyUserPolicyOverride(
  global: ResolvedCostPolicyConfig,
  override: UserPolicyOverride | null,
): ResolvedCostPolicyConfig {
  if (!override) return global;
  return {
    freeTierBudgetUsd: override.freeTierBudgetUsd ?? global.freeTierBudgetUsd,
    freeTierWindowHours: override.freeTierWindowHours ?? global.freeTierWindowHours,
  };
}

export async function checkUserBudget(
  input: CheckUserBudgetInput,
): Promise<UserBudgetStatus> {
  const openRouterKey = input.keyStore.getOpenRouterKey(input.userArc);
  if (openRouterKey) {
    return {
      allowed: true,
      state: "byok",
      openRouterKey,
    };
  }

  if (input.policyStore.isExempt(input.userArc)) {
    return {
      allowed: true,
      state: "exempt",
    };
  }

  const globalPolicy = resolveCostPolicyConfig(input.costPolicy);
  if (!globalPolicy) {
    return {
      allowed: true,
      state: "free",
    };
  }

  const userOverride = input.policyStore.getBudgetOverride(input.userArc);
  const policy = applyUserPolicyOverride(globalPolicy, userOverride);

  const spent = await input.ledger.getUserCostInWindow(
    input.userArc,
    policy.freeTierWindowHours,
    { now: input.now, byok: false },
  );
  const remaining = Math.max(0, policy.freeTierBudgetUsd - spent);
  const allowed = spent < policy.freeTierBudgetUsd;
  const usageFraction = policy.freeTierBudgetUsd > 0 ? spent / policy.freeTierBudgetUsd : 0;

  return {
    allowed,
    state: allowed ? "free" : "over_budget",
    spent,
    remaining,
    budget: policy.freeTierBudgetUsd,
    windowHours: policy.freeTierWindowHours,
    usageFraction,
  };
}

// ── Quota warning cooldown ──

export interface QuotaWarningCooldown {
  lastWarningTs: string;
}

/**
 * Check whether a quota-approaching warning should be emitted, and if so,
 * update the cooldown timestamp. Returns true if the warning should fire.
 *
 * Cooldown period = 5% of the quota window (e.g. 3.6h for a 72h window).
 */
export function shouldEmitQuotaWarning(
  muaddibHome: string,
  userArc: string,
  usageFraction: number,
  windowHours: number,
  now?: Date,
): boolean {
  if (usageFraction < 0.9) return false;

  const cooldownMs = windowHours * 0.05 * 3_600_000;
  const nowMs = (now ?? new Date()).getTime();
  const filePath = quotaWarningPath(muaddibHome, userArc);

  const lastTs = readQuotaWarningTs(filePath);
  if (lastTs !== null && nowMs - lastTs < cooldownMs) {
    return false;
  }

  writeQuotaWarningTs(filePath, new Date(nowMs).toISOString());
  return true;
}

/**
 * Read the last warning timestamp. Exported for testing.
 */
export function readQuotaWarningTs(filePath: string): number | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as QuotaWarningCooldown;
    const ms = Date.parse(data.lastWarningTs);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function writeQuotaWarningTs(filePath: string, ts: string): void {
  const data: QuotaWarningCooldown = { lastWarningTs: ts };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data) + "\n", "utf-8");
}

function quotaWarningPath(muaddibHome: string, userArc: string): string {
  return join(muaddibHome, "users", userArc, "quota-warning.json");
}
