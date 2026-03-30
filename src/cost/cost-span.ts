import { AsyncLocalStorage } from "node:async_hooks";

import type { Usage } from "@mariozechner/pi-ai";

import { cloneUsage, emptyUsage, accumulateUsage } from "./usage.js";
import type { ChatHistoryStore } from "../history/chat-history-store.js";
import type { LlmCallType } from "./llm-call-type.js";
import type { UserCostLedger } from "./user-cost-ledger.js";

export interface CostSpanAttributes {
  arc?: string;
  userArc?: string;
  byok?: boolean;
  trigger?: string;
  [key: string]: unknown;
}

interface RawCostEntry {
  callType: LlmCallType;
  model: string;
  usage: Usage;
}

export interface CostEntry extends RawCostEntry {
  spanName: string;
  attributes: CostSpanAttributes;
}

const costSpanStorage = new AsyncLocalStorage<CostSpan | null>();

export class CostSpan {
  readonly name: string;
  readonly parent: CostSpan | null;
  private readonly localAttributes: CostSpanAttributes;
  private readonly rawEntries: RawCostEntry[] = [];
  private readonly childSpans: CostSpan[] = [];

  constructor(name: string, parent: CostSpan | null = null, attributes: CostSpanAttributes = {}) {
    this.name = name;
    this.parent = parent;
    this.localAttributes = { ...attributes };
  }

  get attributes(): CostSpanAttributes {
    return this.parent
      ? { ...this.parent.attributes, ...this.localAttributes }
      : { ...this.localAttributes };
  }

  get children(): readonly CostSpan[] {
    return this.childSpans;
  }

  updateAttributes(attributes: CostSpanAttributes): void {
    Object.assign(this.localAttributes, attributes);
  }

  createChild(name: string, attributes: CostSpanAttributes = {}): CostSpan {
    const child = new CostSpan(name, this, attributes);
    this.childSpans.push(child);
    return child;
  }

  recordUsage(callType: LlmCallType, model: string, usage: Usage): void {
    this.rawEntries.push({
      callType,
      model,
      usage: cloneUsage(usage),
    });
  }

  entries(): CostEntry[] {
    return this.rawEntries.map((entry) => ({
      callType: entry.callType,
      model: entry.model,
      usage: cloneUsage(entry.usage),
      spanName: this.name,
      attributes: { ...this.attributes },
    }));
  }

  allEntries(): CostEntry[] {
    return [
      ...this.entries(),
      ...this.childSpans.flatMap((child) => child.allEntries()),
    ];
  }

  totalUsage(): Usage {
    const total = emptyUsage();
    for (const entry of this.allEntries()) {
      accumulateUsage(total, entry.usage);
    }
    return total;
  }
}

export function currentCostSpan(): CostSpan | null {
  return costSpanStorage.getStore() ?? null;
}

export async function withCostSpan<T>(
  name: string,
  attributes: CostSpanAttributes = {},
  fn: (span: CostSpan) => Promise<T> | T,
): Promise<T> {
  const parent = currentCostSpan();
  const span = parent
    ? parent.createChild(name, attributes)
    : new CostSpan(name, null, attributes);

  return await costSpanStorage.run(span, async () => await fn(span));
}

export async function withPersistedCostSpan<T>(
  name: string,
  attributes: CostSpanAttributes,
  options: {
    history: ChatHistoryStore;
    run?: string;
    userCostLedger?: UserCostLedger;
  },
  fn: (span: CostSpan) => Promise<T> | T,
): Promise<T> {
  let span: CostSpan | null = null;
  try {
    return await withCostSpan(name, attributes, async (rootSpan) => {
      span = rootSpan;
      return await fn(rootSpan);
    });
  } finally {
    if (span) {
      await persistCostSpan(span, options);
    }
  }
}

export function recordUsage(callType: LlmCallType, model: string, usage: Usage): void {
  const hasUsage =
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.totalTokens > 0 ||
    usage.cost.input > 0 ||
    usage.cost.output > 0 ||
    usage.cost.cacheRead > 0 ||
    usage.cost.cacheWrite > 0 ||
    usage.cost.total > 0;

  if (!hasUsage) {
    return;
  }

  currentCostSpan()?.recordUsage(callType, model, usage);
}

export async function persistCostSpan(
  span: CostSpan,
  options: {
    history: ChatHistoryStore;
    run?: string;
    userCostLedger?: UserCostLedger;
  },
): Promise<void> {
  const arc = typeof span.attributes.arc === "string" ? span.attributes.arc : undefined;
  if (!arc) {
    return;
  }

  const userArc = typeof span.attributes.userArc === "string" ? span.attributes.userArc : undefined;
  const byok = span.attributes.byok === true;

  for (const entry of span.allEntries()) {
    await options.history.logLlmCost(arc, {
      ...(options.run ? { run: options.run } : {}),
      call: entry.callType,
      model: entry.model,
      inTok: entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite,
      outTok: entry.usage.output,
      cost: entry.usage.cost.total,
    });

    if (
      userArc &&
      options.userCostLedger &&
      entry.usage.cost.total > 0
    ) {
      const ledgerModel = typeof entry.attributes.requestedAgentModel === "string"
        ? entry.attributes.requestedAgentModel
        : entry.model;
      await options.userCostLedger.logUserCost(userArc, {
        cost: entry.usage.cost.total,
        byok,
        arc,
        model: ledgerModel,
      });
    }
  }
}
