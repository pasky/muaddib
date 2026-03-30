import type { CostPolicyConfig } from "../config/muaddib-config.js";
import { UserCostLedger } from "./user-cost-ledger.js";
import { UserKeyStore } from "./user-key-store.js";

export type UserBudgetState = "byok" | "exempt" | "free" | "over_budget";

export interface UserBudgetStatus {
  allowed: boolean;
  state: UserBudgetState;
  remaining?: number;
  openRouterKey?: string;
  spent?: number;
  budget?: number;
  windowHours?: number;
}

export interface ResolvedCostPolicyConfig {
  freeTierBudgetUsd: number;
  freeTierWindowHours: number;
}

export interface CheckUserBudgetInput {
  costPolicy?: CostPolicyConfig;
  userArc: string;
  keyStore: UserKeyStore;
  ledger: UserCostLedger;
  now?: Date;
}

export function resolveCostPolicyConfig(
  config: CostPolicyConfig | undefined,
): ResolvedCostPolicyConfig | null {
  if (config === undefined) {
    return null;
  }

  const freeTierBudgetUsd = config.freeTierBudgetUsd ?? 2.0;
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

  if (input.keyStore.isExempt(input.userArc)) {
    return {
      allowed: true,
      state: "exempt",
    };
  }

  const policy = resolveCostPolicyConfig(input.costPolicy);
  if (!policy) {
    return {
      allowed: true,
      state: "free",
    };
  }

  const spent = await input.ledger.getUserCostInWindow(
    input.userArc,
    policy.freeTierWindowHours,
    { now: input.now, byok: false },
  );
  const remaining = Math.max(0, policy.freeTierBudgetUsd - spent);
  const allowed = spent < policy.freeTierBudgetUsd;

  return {
    allowed,
    state: allowed ? "free" : "over_budget",
    spent,
    remaining,
    budget: policy.freeTierBudgetUsd,
    windowHours: policy.freeTierWindowHours,
  };
}
