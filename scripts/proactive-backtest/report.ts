#!/usr/bin/env npx tsx
/**
 * Score backtest runs against the silver standard (and optional gold
 * annotations), and emit a disagreement sheet for human annotation.
 *
 * Metrics (lower is better for both; FP is the one that matters most):
 *   FP rate = P(candidate interjects | silver/gold says NULL)   — annoying
 *   FN rate = P(candidate NULLs      | silver/gold says interject) — missed
 * Refusals count as NULL decisions (production must suppress them), but are
 * also reported separately. Errors are excluded from rates.
 *
 * Usage:
 *   npx tsx scripts/proactive-backtest/report.ts \
 *     --dataset scripts/proactive-backtest/data/dataset.jsonl \
 *     [--annotations <sheet.md>]... \
 *     [--split dev|heldout [--dev-max-null 60] [--dev-max-interject 60] [--seed backtest-v1]] \
 *     [--paired-baseline <run.jsonl>] \
 *     [--disagreements-for <run.jsonl> --disagreements-out <sheet.md>] \
 *     scripts/proactive-backtest/results/*.jsonl
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";

import {
  mcnemarExactP,
  parseGoldAnnotations,
  sampleDataset,
  type DatasetExample,
} from "./lib.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function argValues(flag: string): string[] {
  return process.argv.flatMap((a, i) => (a === flag && i + 1 < process.argv.length ? [process.argv[i + 1]] : []));
}

interface RunRecord {
  id: string;
  label: string;
  decision: string;
  text: string;
  costUsd: number;
  latencyMs: number;
}

const datasetPath = argValue("--dataset");
if (!datasetPath) {
  console.error("Usage: report.ts --dataset <jsonl> [--annotations <md>] [--disagreements-for <run.jsonl> --disagreements-out <md>] <results.jsonl>...");
  process.exit(1);
}
const flagsWithValue = new Set([
  "--dataset", "--annotations", "--disagreements-for", "--disagreements-out", "--disagreements-max", "--disagreements-type",
  "--split", "--dev-max-null", "--dev-max-interject", "--seed", "--paired-baseline",
]);
const resultPaths: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  if (flagsWithValue.has(process.argv[i])) { i++; continue; }
  resultPaths.push(process.argv[i]);
}

const dataset = new Map<string, DatasetExample>();
for (const line of readFileSync(datasetPath, "utf8").trim().split("\n")) {
  const ex = JSON.parse(line) as DatasetExample;
  dataset.set(ex.id, ex);
}

// ── Gold annotations: lines of the form `gold[<id>]: interject|null|either`,
// merged across all --annotations sheets ──
const annotationPaths = argValues("--annotations");
const gold = parseGoldAnnotations(annotationPaths.map((path) => ({ path, text: readFileSync(path, "utf8") })));
if (annotationPaths.length) {
  console.log(`Loaded ${gold.size} gold annotations from ${annotationPaths.join(", ")}`);
}

// ── Split: the dev subset is the nested sample run.ts draws with the same
// caps + seed; "heldout" is its complement (never used for prompt selection) ──
const split = argValue("--split");
let splitIds: Set<string> | null = null;
if (split !== undefined) {
  if (split !== "dev" && split !== "heldout") throw new Error(`--split must be dev or heldout, got '${split}'`);
  const caps = { null: Number(argValue("--dev-max-null") ?? "60"), interject: Number(argValue("--dev-max-interject") ?? "60") };
  if (!Number.isInteger(caps.null) || !Number.isInteger(caps.interject)) throw new Error("--dev-max-* must be integers");
  const devIds = new Set(sampleDataset([...dataset.values()], caps, argValue("--seed") ?? "backtest-v1").map((ex) => ex.id));
  splitIds = split === "dev" ? devIds : new Set([...dataset.keys()].filter((id) => !devIds.has(id)));
  console.log(`Split ${split}: ${splitIds.size} dataset examples`);
}

/** Effective reference label: gold overrides silver; "either" → skip. */
function refLabel(id: string, silver: string): string | null {
  const g = gold.get(id);
  if (g === "either") return null;
  return g ?? silver;
}

function loadRun(path: string): RunRecord[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as RunRecord)
    .filter((r) => splitIds === null || splitIds.has(r.id));
}

/** Interject-vs-NULL decision for scoring (refusals count as NULL), or null for errors. */
function decidedOf(r: RunRecord): string | null {
  if (r.decision === "error") return null;
  return r.decision === "refusal" ? "null" : r.decision;
}

// ── Metrics table ──

interface Row {
  name: string; n: number; fpPct: number; fnPct: number; agreePct: number;
  fp: number; fn: number; nNull: number; nInterject: number;
  refusals: number; errors: number; costUsd: number; p50ms: number; p90ms: number;
}

const rows: Row[] = [];
for (const path of resultPaths) {
  const recs = loadRun(path);
  let fp = 0, fn = 0, nNull = 0, nInterject = 0, refusals = 0, errors = 0, agree = 0, scored = 0;
  let cost = 0;
  const latencies: number[] = [];
  for (const r of recs) {
    cost += r.costUsd;
    latencies.push(r.latencyMs);
    const decided = decidedOf(r);
    if (decided === null) { errors++; continue; }
    if (r.decision === "refusal") refusals++;
    const ref = refLabel(r.id, r.label);
    if (ref === null) continue;
    scored++;
    if (ref === "null") { nNull++; if (decided === "interject") fp++; else agree++; }
    else { nInterject++; if (decided === "null") fn++; else agree++; }
  }
  latencies.sort((a, b) => a - b);
  const pct = (x: number, n: number): number => (n ? (100 * x) / n : 0);
  rows.push({
    name: basename(path, ".jsonl"), n: scored,
    fpPct: pct(fp, nNull), fnPct: pct(fn, nInterject), agreePct: pct(agree, scored),
    fp, fn, nNull, nInterject, refusals, errors, costUsd: cost,
    p50ms: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
    p90ms: latencies[Math.floor(latencies.length * 0.9)] ?? 0,
  });
}

rows.sort((a, b) => a.fpPct - b.fpPct || a.fnPct - b.fnPct);
const header = ["run", "n", "FP%", "FN%", "agree%", "FP", "FN", "refusals", "errors", "cost$", "p50s", "p90s"];
const table = [header, ...rows.map((r) => [
  r.name, String(r.n),
  r.fpPct.toFixed(1), r.fnPct.toFixed(1), r.agreePct.toFixed(1),
  `${r.fp}/${r.nNull}`, `${r.fn}/${r.nInterject}`,
  String(r.refusals), String(r.errors), r.costUsd.toFixed(2),
  (r.p50ms / 1000).toFixed(1), (r.p90ms / 1000).toFixed(1),
])];
const widths = header.map((_, i) => Math.max(...table.map((row) => row[i].length)));
for (const row of table) {
  console.log(row.map((c, i) => c.padEnd(widths[i] + 2)).join(""));
}

// ── Paired comparison vs a baseline run (same ids, same reference labels) ──
// On ref-NULL cases the discordant pairs are FP-only-in-one-run; on
// ref-interject cases FN-only-in-one-run. Exact McNemar on each.

const pairedBaseline = argValue("--paired-baseline");
if (pairedBaseline) {
  const base = new Map(loadRun(pairedBaseline).map((r) => [r.id, r]));
  const baseName = basename(pairedBaseline, ".jsonl");
  console.log(`\nPaired vs ${baseName} (base-only / cand-only errors, exact McNemar p):`);
  const pHeader = ["run", "pairs", "FP base/cand", "p(FP)", "FN base/cand", "p(FN)"];
  const pTable = [pHeader];
  for (const path of resultPaths) {
    if (basename(path, ".jsonl") === baseName) continue;
    let pairs = 0, fpBase = 0, fpCand = 0, fnBase = 0, fnCand = 0;
    for (const r of loadRun(path)) {
      const b = base.get(r.id);
      const ref = refLabel(r.id, r.label);
      const dc = decidedOf(r);
      const db = b ? decidedOf(b) : null;
      if (ref === null || dc === null || db === null) continue;
      pairs++;
      if (dc === db) continue;
      if (ref === "null") { if (db === "interject") fpBase++; else fpCand++; }
      else { if (db === "null") fnBase++; else fnCand++; }
    }
    pTable.push([
      basename(path, ".jsonl"), String(pairs),
      `${fpBase}/${fpCand}`, mcnemarExactP(fpBase, fpCand).toFixed(3),
      `${fnBase}/${fnCand}`, mcnemarExactP(fnBase, fnCand).toFixed(3),
    ]);
  }
  const pWidths = pHeader.map((_, i) => Math.max(...pTable.map((row) => row[i].length)));
  for (const row of pTable) console.log(row.map((c, i) => c.padEnd(pWidths[i] + 2)).join(""));
}

// ── Disagreement sheet for annotation ──

const disFor = argValue("--disagreements-for");
if (disFor) {
  const disOut = argValue("--disagreements-out") ?? disFor.replace(/\.jsonl$/, "-disagreements.md");
  const disMax = argValue("--disagreements-max") ? Number(argValue("--disagreements-max")) : Infinity;
  // "fp" = candidate spoke where silver stayed silent; "fn" = the reverse.
  const disType = argValue("--disagreements-type") ?? "all";
  // FP-type first (annotation priority), then deterministic by id (results
  // files are in concurrent-completion order).
  const recs = loadRun(disFor)
    .filter((r) => disType === "all" || (disType === "fp" ? r.label === "null" : r.label === "interject"))
    .sort((a, b) =>
      Number(b.label === "null") - Number(a.label === "null") || (a.id < b.id ? -1 : 1));
  const lines: string[] = [
    `# Disagreements: ${basename(disFor)}`,
    "",
    "For each case, fill in the `gold[...]:` line with `interject` (bot SHOULD speak up),",
    "`null` (bot should stay silent), or `either` (both fine / don't score).",
    "Feed the filled file back via `report.ts --annotations <this file>`.",
    "",
  ];
  let count = 0;
  for (const r of recs) {
    if (count >= disMax) break;
    // Already adjudicated in some --annotations sheet: don't ask again.
    if (gold.has(r.id)) continue;
    const decided = decidedOf(r);
    if (decided === null || decided === r.label) continue;
    const ex = dataset.get(r.id);
    if (!ex) continue;
    count++;
    lines.push(`## ${count}. ${r.id}`);
    lines.push("");
    lines.push("```");
    for (const m of ex.messages.slice(-6)) {
      const text = m.text.length > 300 ? m.text.slice(0, 300) + "…" : m.text;
      lines.push(m.role === "assistant" ? `<BOT> ${text}` : text);
    }
    lines.push("```");
    lines.push("");
    lines.push(`- silver (${ex.silverModel}): **${ex.label}**${ex.deliveredSnippet ? ` — said: ${ex.deliveredSnippet.slice(0, 200)}` : ""}`);
    const candText = r.text.length > 200 ? r.text.slice(0, 200) + "…" : r.text;
    lines.push(`- candidate: **${r.decision}**${candText ? ` — ${candText}` : ""}`);
    lines.push("");
    lines.push(`gold[${r.id}]: `);
    lines.push("");
  }
  mkdirSync(dirname(disOut), { recursive: true });
  writeFileSync(disOut, lines.join("\n") + "\n");
  console.log(`\n${count} disagreements → ${disOut}`);
}
