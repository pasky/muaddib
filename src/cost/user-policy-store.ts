import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface UserPolicyOverride {
  freeTierBudgetUsd?: number;
  freeTierWindowHours?: number;
}

/** A single per-trigger model override set by a BYOK user. */
export interface TriggerModelEntry {
  model: string;
  /** The operator's effective default for this trigger at the time the override was set. */
  systemDefaultAtSet: string;
  /** ISO timestamp of when the override was set. */
  setAt: string;
}

export interface UserPolicy {
  exempt?: boolean;
  freeTierBudgetUsd?: number;
  freeTierWindowHours?: number;
  /** Per-trigger model overrides (BYOK perk, user-managed). */
  triggerModels?: Record<string, TriggerModelEntry>;
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

  // ── Trigger model overrides (BYOK perk) ──

  getTriggerModel(userArc: string, trigger: string): TriggerModelEntry | null {
    return this.load(userArc)?.triggerModels?.[trigger] ?? null;
  }

  listTriggerModels(userArc: string): Record<string, TriggerModelEntry> {
    return this.load(userArc)?.triggerModels ?? {};
  }

  setTriggerModel(
    userArc: string,
    trigger: string,
    entry: TriggerModelEntry,
  ): void {
    this.updateTriggerModels(userArc, (models) => {
      models[trigger] = entry;
    });
  }

  clearTriggerModel(userArc: string, trigger: string): boolean {
    let existed = false;
    this.updateTriggerModels(userArc, (models) => {
      existed = trigger in models;
      delete models[trigger];
    });
    return existed;
  }

  clearAllTriggerModels(userArc: string): number {
    let count = 0;
    this.updateTriggerModels(userArc, (models) => {
      count = Object.keys(models).length;
      for (const key of Object.keys(models)) {
        delete models[key];
      }
    });
    return count;
  }

  /**
   * Update the stored systemDefaultAtSet for a trigger so the drift
   * warning is not repeated until the operator changes the default again.
   */
  markSystemDefaultNotified(
    userArc: string,
    trigger: string,
    newDefault: string,
  ): void {
    this.updateTriggerModels(userArc, (models) => {
      if (models[trigger]) {
        models[trigger].systemDefaultAtSet = newDefault;
      }
    });
  }

  // ── Internals ──

  private load(userArc: string): UserPolicy | null {
    const filePath = this.filePath(userArc);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
    const data = JSON.parse(raw) as Record<string, unknown>;
    return this.validate(data, userArc);
  }

  private save(userArc: string, policy: UserPolicy): void {
    const filePath = this.filePath(userArc);
    mkdirSync(dirname(filePath), { recursive: true });
    const data: Record<string, unknown> = {};
    if (policy.exempt !== undefined) data.exempt = policy.exempt;
    if (policy.freeTierBudgetUsd !== undefined) data.freeTierBudgetUsd = policy.freeTierBudgetUsd;
    if (policy.freeTierWindowHours !== undefined) data.freeTierWindowHours = policy.freeTierWindowHours;
    if (policy.triggerModels && Object.keys(policy.triggerModels).length > 0) {
      data.triggerModels = policy.triggerModels;
    }
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    renameSync(tmp, filePath);
  }

  private filePath(userArc: string): string {
    return join(this.muaddibHome, "users", userArc, "policy.json");
  }

  private updateTriggerModels(
    userArc: string,
    mutate: (models: Record<string, TriggerModelEntry>) => void,
  ): void {
    const policy = this.load(userArc) ?? {};
    const models = policy.triggerModels ?? {};
    mutate(models);
    policy.triggerModels = models;
    this.save(userArc, policy);
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

    if (data.triggerModels !== undefined) {
      if (typeof data.triggerModels !== "object" || data.triggerModels === null || Array.isArray(data.triggerModels)) {
        throw new Error(`users/${userArc}/policy.json: triggerModels must be an object.`);
      }
      const models: Record<string, TriggerModelEntry> = {};
      for (const [trigger, entry] of Object.entries(data.triggerModels as Record<string, unknown>)) {
        if (!trigger.startsWith("!")) {
          throw new Error(`users/${userArc}/policy.json: triggerModels key '${trigger}' must start with '!'.`);
        }
        if (
          typeof entry !== "object" ||
          entry === null ||
          typeof (entry as Record<string, unknown>).model !== "string" ||
          typeof (entry as Record<string, unknown>).systemDefaultAtSet !== "string" ||
          typeof (entry as Record<string, unknown>).setAt !== "string"
        ) {
          throw new Error(
            `users/${userArc}/policy.json: triggerModels['${trigger}'] must have string fields: model, systemDefaultAtSet, setAt.`,
          );
        }
        models[trigger] = entry as TriggerModelEntry;
      }
      policy.triggerModels = models;
    }

    return policy;
  }
}
