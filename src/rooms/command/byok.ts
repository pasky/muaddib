/**
 * BYOK (Bring Your Own Key) command handlers and model remap logic.
 *
 * Extracted from CommandExecutor to keep billing/key management concerns
 * separate from core agent invocation.
 */

import { parseModelSpec } from "../../models/model-spec.js";
import {
  checkUserBudget,
  resolveCostPolicyConfig,
} from "../../cost/cost-policy.js";
import type { CostPolicyConfig } from "../../config/muaddib-config.js";
import {
  buildUserArc,
  parseSetKeyArgs,
  type UserKeyStore,
} from "../../cost/user-key-store.js";
import type { UserPolicyStore, TriggerModelEntry } from "../../cost/user-policy-store.js";
import type { UserCostLedger } from "../../cost/user-cost-ledger.js";
import type { RoomMessage } from "../message.js";
import { pickModeModel, type CommandConfig } from "./resolver.js";

// ── Builtin command handlers ──

export async function handleSetKeyCommand(
  userKeyStore: UserKeyStore,
  message: RoomMessage,
  queryText: string,
  deliver: (text: string) => Promise<void>,
): Promise<void> {
  const args = parseSetKeyArgs(queryText);
  if (!args || args.provider !== "openrouter") {
    await deliver(`${message.nick}: usage: !setkey openrouter <key> (omit <key> to clear)`);
    return;
  }

  const secretKey = typeof message.secrets?.setkeyKey === "string"
    ? message.secrets.setkeyKey
    : undefined;
  const key = secretKey ?? (args.key === "[redacted]" ? null : args.key);
  const userArc = buildUserArc(message.serverTag, message.nick);

  if (key) {
    userKeyStore.setOpenRouterKey(userArc, key);
    await deliver(`${message.nick}: saved your OpenRouter key. Future commands will use OpenRouter on your dime. To clear it: /msg <me> !setkey openrouter`);
    return;
  }

  userKeyStore.clearOpenRouterKey(userArc);
  await deliver(`${message.nick}: cleared your OpenRouter key. You're back on the free tier.`);
}

export async function handleBalanceCommand(
  input: {
    costPolicy: CostPolicyConfig | undefined;
    keyStore: UserKeyStore;
    policyStore: UserPolicyStore;
    ledger: UserCostLedger;
  },
  message: RoomMessage,
  deliver: (text: string) => Promise<void>,
): Promise<void> {
  const userArc = buildUserArc(message.serverTag, message.nick);
  const { costPolicy, keyStore, policyStore, ledger } = input;
  const status = await checkUserBudget({
    costPolicy,
    userArc,
    keyStore,
    policyStore,
    ledger,
  });

  const byokGuide = [
    "To bring your own OpenRouter key:",
    "1. Sign up at https://openrouter.ai/ - there is a variety of payment options including Stripe and LN",
    "2. Go to https://openrouter.ai/keys to create an API key",
    "3. IMPORTANT: set a tight budget limit on this key (bot operator assumes no responsibility; keys may leak, bot may be buggy, ...)",
    "4. Send me the key via DM: /msg <me> !setkey openrouter <your-key>",
  ].join("\n");

  if (status.state === "byok") {
    const policy = resolveCostPolicyConfig(costPolicy);
    if (!policy) {
      await deliver(`${message.nick}: BYOK is active via OpenRouter. Free-tier budget enforcement is disabled on this bot. To clear your key: /msg <me> !setkey openrouter`);
      return;
    }

    const freeSpend = await ledger.getUserCostInWindow(userArc, policy.freeTierWindowHours, { byok: false });
    const byokSpend = await ledger.getUserCostInWindow(userArc, policy.freeTierWindowHours, { byok: true });
    await deliver(`${message.nick}: BYOK is active via OpenRouter. Free tier usage in the last ${policy.freeTierWindowHours}h: $${freeSpend.toFixed(4)} / $${policy.freeTierBudgetUsd.toFixed(2)}. BYOK usage in the same window: $${byokSpend.toFixed(4)}. To clear your key: /msg <me> !setkey openrouter`);
    return;
  }

  if (status.state === "exempt") {
    const policy = resolveCostPolicyConfig(costPolicy);
    if (!policy) {
      await deliver(`${message.nick}: operator-funded access is enabled for you (exempt), and free-tier budget enforcement is disabled on this bot.`);
      return;
    }

    const exemptSpend = await ledger.getUserCostInWindow(userArc, policy.freeTierWindowHours, { byok: false });
    await deliver(`${message.nick}: operator-funded access is enabled for you (exempt from the free tier). Operator-funded usage in the last ${policy.freeTierWindowHours}h: $${exemptSpend.toFixed(4)}.`);
    return;
  }

  const policy = resolveCostPolicyConfig(costPolicy);
  if (!policy) {
    await deliver(`${message.nick}: free-tier budget enforcement is disabled on this bot.\n${byokGuide}`);
    return;
  }

  const spent = status.spent ?? 0;
  const remaining = status.remaining ?? Math.max(0, policy.freeTierBudgetUsd - spent);

  if (status.state === "over_budget") {
    await deliver(`${message.nick}: your free tier budget is exhausted — $${spent.toFixed(4)} / $${policy.freeTierBudgetUsd.toFixed(2)} in the last ${policy.freeTierWindowHours}h. To keep using me, bring your own OpenRouter key:\n${byokGuide}`);
    return;
  }

  await deliver(`${message.nick}: free tier usage is $${spent.toFixed(4)} / $${policy.freeTierBudgetUsd.toFixed(2)} in the last ${policy.freeTierWindowHours}h; $${remaining.toFixed(4)} remaining.\n${byokGuide}`);
}

export async function handleSetModelCommand(
  input: {
    costPolicy: CostPolicyConfig | undefined;
    keyStore: UserKeyStore;
    policyStore: UserPolicyStore;
    ledger: UserCostLedger;
    commandConfig: CommandConfig;
    triggerToMode: Record<string, string>;
    triggerOverrides: Record<string, Record<string, unknown>>;
  },
  message: RoomMessage,
  queryText: string,
  deliver: (text: string) => Promise<void>,
): Promise<void> {
  const { costPolicy, keyStore, policyStore, ledger, commandConfig, triggerToMode, triggerOverrides } = input;
  const userArc = buildUserArc(message.serverTag, message.nick);

  // Require BYOK-active
  const budgetStatus = await checkUserBudget({
    costPolicy,
    userArc,
    keyStore,
    policyStore,
    ledger,
  });
  if (budgetStatus.state !== "byok") {
    await deliver(`${message.nick}: !setmodel requires an active BYOK key. Set one first with !setkey openrouter <key>.`);
    return;
  }

  const tokens = queryText.trim().split(/\s+/).filter(Boolean);

  // No args: list current remaps
  if (tokens.length === 0) {
    await listTriggerModels(policyStore, triggerToMode, triggerOverrides, commandConfig, userArc, message.nick, deliver);
    return;
  }

  // "clear" — clear all remaps
  if (tokens.length === 1 && tokens[0] === "clear") {
    const count = policyStore.clearAllTriggerModels(userArc);
    if (count === 0) {
      await deliver(`${message.nick}: no model remaps to clear.`);
    } else {
      await deliver(`${message.nick}: cleared ${count} model remap(s). Back to operator defaults.`);
    }
    return;
  }

  const trigger = tokens[0];

  // Validate trigger
  if (!triggerToMode[trigger]) {
    const validTriggers = Object.keys(triggerToMode).join(", ");
    await deliver(`${message.nick}: unknown trigger '${trigger}'. Valid triggers: ${validTriggers}`);
    return;
  }

  // Single trigger arg: clear that remap
  if (tokens.length === 1) {
    const existed = policyStore.clearTriggerModel(userArc, trigger);
    if (existed) {
      await deliver(`${message.nick}: cleared model remap for ${trigger}. Back to operator default.`);
    } else {
      await deliver(`${message.nick}: no model remap set for ${trigger}.`);
    }
    return;
  }

  // Two args: set remap
  const modelInput = tokens[1];
  try {
    parseModelSpec(modelInput);
  } catch {
    await deliver(`${message.nick}: invalid model spec '${modelInput}'. Expected format: provider:model (e.g. openrouter:x-ai/grok-4).`);
    return;
  }

  // Compute operator default for this trigger
  const modeKey = triggerToMode[trigger];
  const modeConfig = commandConfig.modes[modeKey];
  const overrides = triggerOverrides[trigger] ?? {};
  const operatorDefault =
    (overrides.model as string | undefined) ??
    pickModeModel(modeConfig.model) ??
    "(none)";

  const entry: TriggerModelEntry = {
    model: modelInput,
    systemDefaultAtSet: operatorDefault,
    setAt: new Date().toISOString(),
  };
  policyStore.setTriggerModel(userArc, trigger, entry);
  await deliver(
    `${message.nick}: ${trigger} remapped to ${modelInput} (operator default: ${operatorDefault}). Clear with: !setmodel ${trigger}`,
  );
}

async function listTriggerModels(
  policyStore: UserPolicyStore,
  triggerToMode: Record<string, string>,
  triggerOverrides: Record<string, Record<string, unknown>>,
  commandConfig: CommandConfig,
  userArc: string,
  nick: string,
  deliver: (text: string) => Promise<void>,
): Promise<void> {
  const models = policyStore.listTriggerModels(userArc);
  const entries = Object.entries(models);
  if (entries.length === 0) {
    await deliver(`${nick}: no model remaps set. Use !setmodel <trigger> <model> to remap a prefix (e.g. !setmodel !s openrouter:x-ai/grok-4). Use !h to see operator defaults.`);
    return;
  }

  const lines = entries.map(([trigger, entry]) => {
    const modeKey = triggerToMode[trigger];
    const modeConfig = modeKey ? commandConfig.modes[modeKey] : undefined;
    const overrides = triggerOverrides[trigger] ?? {};
    const currentDefault =
      (overrides.model as string | undefined) ??
      pickModeModel(modeConfig?.model) ??
      "(none)";

    let line = `  ${trigger} → ${entry.model}`;
    if (currentDefault !== entry.systemDefaultAtSet) {
      line += ` ⚠ operator default changed (was ${entry.systemDefaultAtSet}, now ${currentDefault})`;
    }
    return line;
  });

  await deliver(`${nick}: your BYOK model remaps:\n${lines.join("\n")}\nTo clear: !setmodel <trigger>. To see operator defaults: !h`);
}

// ── Model remap resolution ──

export interface ByokRemapResult {
  /** The (potentially remapped) model spec to use. */
  remappedModelSpec: string;
  /** Optional drift warning to deliver to the user after the agent run. */
  driftWarning: string | null;
}

/**
 * Resolve BYOK user model remap for the given trigger.
 * Returns the (potentially remapped) model spec and an optional drift warning.
 */
export function resolveByokRemap(
  policyStore: UserPolicyStore,
  triggerOverrides: Record<string, Record<string, unknown>>,
  userArc: string,
  nick: string,
  trigger: string,
  modelSpec: string,
  modeConfig: { model?: string | string[] },
  logger?: { debug: (...args: string[]) => void },
): ByokRemapResult {
  const userRemap = policyStore.getTriggerModel(userArc, trigger);
  if (!userRemap) {
    return { remappedModelSpec: modelSpec, driftWarning: null };
  }

  const remappedModelSpec = userRemap.model;
  logger?.debug(
    "Applying BYOK user model remap",
    `trigger=${trigger}`,
    `remap=${userRemap.model}`,
    `operatorDefault=${modelSpec}`,
  );

  // Check for operator default drift
  const overrides = triggerOverrides[trigger] ?? {};
  const currentOperatorDefault =
    (overrides.model as string | undefined) ??
    pickModeModel(modeConfig.model) ??
    "(none)";

  let driftWarning: string | null = null;
  if (currentOperatorDefault !== userRemap.systemDefaultAtSet) {
    driftWarning = `${nick}: heads up \u2014 operator changed default for ${trigger} from ${userRemap.systemDefaultAtSet} to ${currentOperatorDefault}. Your remap ${userRemap.model} is still active. Clear with: /msg <me> !setmodel ${trigger}`;
    policyStore.markSystemDefaultNotified(userArc, trigger, currentOperatorDefault);
  }

  return { remappedModelSpec, driftWarning };
}
