import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface UserPolicyOverride {
  freeTierBudgetUsd?: number;
  freeTierWindowHours?: number;
}

export interface UserPolicy {
  exempt?: boolean;
  freeTierBudgetUsd?: number;
  freeTierWindowHours?: number;
}

export class UserPolicyStore {
  constructor(private readonly muaddibHome: string) {}

  isExempt(userArc: string): boolean {
    return this.load(userArc)?.exempt === true;
  }

  getBudgetOverride(userArc: string): UserPolicyOverride | null {
    const policy = this.load(userArc);
    if (!policy) return null;
    const override: UserPolicyOverride = {};
    if (policy.freeTierBudgetUsd !== undefined) {
      override.freeTierBudgetUsd = policy.freeTierBudgetUsd;
    }
    if (policy.freeTierWindowHours !== undefined) {
      override.freeTierWindowHours = policy.freeTierWindowHours;
    }
    return Object.keys(override).length > 0 ? override : null;
  }

  private load(userArc: string): UserPolicy | null {
    const filePath = join(this.muaddibHome, "users", userArc, "policy.json");
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
    const data = JSON.parse(raw) as Record<string, unknown>;
    return this.validate(data, userArc);
  }

  private validate(data: Record<string, unknown>, userArc: string): UserPolicy {
    const policy: UserPolicy = {};

    if (data.exempt !== undefined) {
      if (typeof data.exempt !== "boolean") {
        throw new Error(`users/${userArc}/policy.json: exempt must be a boolean.`);
      }
      policy.exempt = data.exempt;
    }

    if (data.freeTierBudgetUsd !== undefined) {
      if (typeof data.freeTierBudgetUsd !== "number" || !Number.isFinite(data.freeTierBudgetUsd) || data.freeTierBudgetUsd < 0) {
        throw new Error(`users/${userArc}/policy.json: freeTierBudgetUsd must be a finite number >= 0.`);
      }
      policy.freeTierBudgetUsd = data.freeTierBudgetUsd;
    }

    if (data.freeTierWindowHours !== undefined) {
      if (typeof data.freeTierWindowHours !== "number" || !Number.isFinite(data.freeTierWindowHours) || data.freeTierWindowHours <= 0) {
        throw new Error(`users/${userArc}/policy.json: freeTierWindowHours must be a finite number > 0.`);
      }
      policy.freeTierWindowHours = data.freeTierWindowHours;
    }

    return policy;
  }
}
