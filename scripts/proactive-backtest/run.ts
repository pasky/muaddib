#!/usr/bin/env npx tsx
/**
 * Replay the proactive backtest dataset against a candidate model + prompt.
 *
 * Each example's conversation context is replayed as a single tool-less
 * completion (the production run is a full agent session; tool access mostly
 * affects response *content*, not the interject-vs-NULL decision — and the
 * silver baseline is re-run through this same harness for calibration).
 *
 * Usage:
 *   npx tsx scripts/proactive-backtest/run.ts \
 *     --dataset scripts/proactive-backtest/data/dataset.jsonl \
 *     --auth ~/.muaddib-profiles/MuaddibLLM/auth.json \
 *     --model anthropic:claude-fable-5 \
 *     [--prompt scripts/proactive-backtest/prompts/foo.txt] \
 *     [--reasoning low] [--max-null 60] [--max-interject 60] \
 *     [--concurrency 4] [--out scripts/proactive-backtest/results/foo.jsonl]
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, dirname } from "node:path";

import type { Message, ThinkingLevel } from "@earendil-works/pi-ai";

import { AuthStore } from "../../src/auth/auth-store.js";
import { PiAiModelAdapter } from "../../src/models/pi-ai-model-adapter.js";
import { responseText } from "../../src/agent/message.js";
import { createStubAssistantFields } from "../../src/history/chat-history-store.js";
import { LLM_CALL_TYPE } from "../../src/cost/llm-call-type.js";
import {
  applyPromptVariant,
  classifyDecision,
  sampleDataset,
  type DatasetExample,
  type DecisionResult,
} from "./lib.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const datasetPath = argValue("--dataset");
const authPath = argValue("--auth");
const modelSpec = argValue("--model");
if (!datasetPath || !authPath || !modelSpec) {
  console.error("Usage: run.ts --dataset <jsonl> --auth <auth.json> --model <provider:model> [--prompt <file>] [--reasoning minimal|low|medium|high] [--max-null N] [--max-interject N] [--concurrency N] [--out <jsonl>] [--seed s]");
  process.exit(1);
}
const promptPath = argValue("--prompt");
const promptVariant = promptPath ? readFileSync(promptPath, "utf8").trim() : null;
const reasoning = (argValue("--reasoning") ?? "low") as ThinkingLevel;
const maxNull = argValue("--max-null") ? Number(argValue("--max-null")) : undefined;
const maxInterject = argValue("--max-interject") ? Number(argValue("--max-interject")) : undefined;
const concurrency = Number(argValue("--concurrency") ?? "4");
const seed = argValue("--seed") ?? "backtest-v1";
const runName = argValue("--name")
  ?? `${modelSpec.replace(/[^a-zA-Z0-9.-]+/g, "_")}${promptPath ? "-" + basename(promptPath).replace(/\.txt$/, "") : ""}-${reasoning}`;
const outPath = argValue("--out") ?? `scripts/proactive-backtest/results/${runName}.jsonl`;

interface RunRecord {
  id: string;
  label: string;
  decision: DecisionResult["decision"];
  text: string;
  costUsd: number;
  latencyMs: number;
  attempts: number;
}

const all: DatasetExample[] = readFileSync(datasetPath, "utf8")
  .trim().split("\n").map((l) => JSON.parse(l) as DatasetExample);
const examples = sampleDataset(all, { null: maxNull, interject: maxInterject }, seed);

// Run identity manifest — refuses to resume into a file produced under
// different experiment parameters (in-place prompt edits, seed changes, ...).
const manifest = {
  model: modelSpec,
  promptSha1: promptVariant ? createHash("sha1").update(promptVariant).digest("hex") : null,
  reasoning,
  seed,
  datasetSha1: createHash("sha1").update(readFileSync(datasetPath)).digest("hex"),
};
const metaPath = outPath.replace(/\.jsonl$/, "") + ".meta.json";
if (existsSync(metaPath)) {
  const prev = JSON.parse(readFileSync(metaPath, "utf8")) as typeof manifest;
  if (JSON.stringify(prev) !== JSON.stringify(manifest)) {
    console.error(`Refusing to resume: ${metaPath} was produced under different parameters:\n  previous: ${JSON.stringify(prev)}\n  current:  ${JSON.stringify(manifest)}`);
    process.exit(1);
  }
}

// Resume support: skip ids already present in the output file (restricted to
// the currently sampled ids so stale rows don't contaminate metrics).
const sampledIds = new Set(examples.map((ex) => ex.id));
const done = new Map<string, RunRecord>();
if (existsSync(outPath)) {
  let stale = 0;
  for (const line of readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean)) {
    const r = JSON.parse(line) as RunRecord;
    if (sampledIds.has(r.id)) done.set(r.id, r);
    else stale++;
  }
  console.log(`Resuming: ${done.size} results already in ${outPath}${stale ? ` (dropping ${stale} outside current sample)` : ""}`);
}

const adapter = new PiAiModelAdapter({ authStorage: AuthStore.create(authPath.replace(/^~/, process.env.HOME ?? "~")) });
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function toMessages(ex: DatasetExample): Message[] {
  return ex.messages.map((m): Message =>
    m.role === "user"
      ? { role: "user", content: m.text }
      : { role: "assistant", content: [{ type: "text", text: m.text }], ...createStubAssistantFields() },
  );
}

async function runOne(ex: DatasetExample): Promise<RunRecord> {
  const systemPrompt = promptVariant ? applyPromptVariant(ex.systemPrompt, promptVariant) : ex.systemPrompt;
  const start = Date.now();
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      const response = await adapter.completeSimple(
        modelSpec!,
        { messages: toMessages(ex), systemPrompt },
        {
          callType: LLM_CALL_TYPE.PROACTIVE_VALIDATION,
          logger: silentLogger,
          streamOptions: { reasoning },
        },
      );
      const result = classifyDecision({
        text: responseText(response),
        stopReason: response.stopReason,
        errorMessage: response.errorMessage,
      });
      if (result.decision === "error" && attempts < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempts));
        continue;
      }
      return {
        id: ex.id,
        label: ex.label,
        decision: result.decision,
        text: result.text,
        costUsd: response.usage?.cost?.total ?? 0,
        latencyMs: Date.now() - start,
        attempts,
      };
    } catch (error) {
      if (attempts < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempts));
        continue;
      }
      return {
        id: ex.id, label: ex.label, decision: "error", text: String(error),
        costUsd: 0, latencyMs: Date.now() - start, attempts,
      };
    }
  }
}

const pending = examples.filter((ex) => !done.has(ex.id));
console.log(`Run ${runName}: model=${modelSpec} reasoning=${reasoning} prompt=${promptPath ?? "(logged)"} examples=${examples.length} pending=${pending.length}`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(metaPath, JSON.stringify(manifest, null, 2) + "\n");

let completed = 0;
let totalCost = 0;
const queue = [...pending];
const results: RunRecord[] = [...done.values()];

async function worker(): Promise<void> {
  for (;;) {
    const ex = queue.shift();
    if (!ex) return;
    const rec = await runOne(ex);
    results.push(rec);
    // Append-as-we-go so interrupted runs can resume.
    writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
    completed++;
    totalCost += rec.costUsd;
    console.log(`[${completed}/${pending.length}] ${rec.decision.padEnd(9)} (silver=${rec.label}) $${totalCost.toFixed(3)} ${ex.id}`);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const agree = results.filter((r) => r.decision === r.label || (r.decision === "refusal" && r.label === "null")).length;
console.log(`Done: ${results.length} results, total cost $${results.reduce((s, r) => s + r.costUsd, 0).toFixed(3)}, raw agreement ${(100 * agree / results.length).toFixed(1)}%`);
console.log(`Results → ${outPath}`);
