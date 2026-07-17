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
 *     [--annotations scripts/proactive-backtest/data/annotations.md] \
 *     [--disagreements-for <run.jsonl> --disagreements-out <sheet.md>] \
 *     scripts/proactive-backtest/results/*.jsonl
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";

import type { DatasetExample } from "./lib.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
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
const flagsWithValue = new Set(["--dataset", "--annotations", "--disagreements-for", "--disagreements-out", "--disagreements-max"]);
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

// ── Gold annotations: lines of the form `gold[<id>]: interject|null|either` ──
const gold = new Map<string, string>();
const annotationsPath = argValue("--annotations");
if (annotationsPath) {
  for (const m of readFileSync(annotationsPath, "utf8").matchAll(/^gold\[([^\]]+)\]:\s*(interject|null|either)\s*$/gm)) {
    gold.set(m[1], m[2]);
  }
  console.log(`Loaded ${gold.size} gold annotations from ${annotationsPath}`);
}

/** Effective reference label: gold overrides silver; "either" → skip. */
function refLabel(id: string, silver: string): string | null {
  const g = gold.get(id);
  if (g === "either") return null;
  return g ?? silver;
}

function loadRun(path: string): RunRecord[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as RunRecord);
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
    if (r.decision === "error") { errors++; continue; }
    if (r.decision === "refusal") refusals++;
    const ref = refLabel(r.id, r.label);
    if (ref === null) continue;
    const decided = r.decision === "refusal" ? "null" : r.decision;
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

// ── Disagreement sheet for annotation ──

const disFor = argValue("--disagreements-for");
if (disFor) {
  const disOut = argValue("--disagreements-out") ?? disFor.replace(/\.jsonl$/, "-disagreements.md");
  const disMax = argValue("--disagreements-max") ? Number(argValue("--disagreements-max")) : Infinity;
  // FP-type disagreements (candidate spoke where reference stayed silent) first —
  // they are the annotation priority; then deterministic by id (results files
  // are in concurrent-completion order).
  const recs = loadRun(disFor).sort((a, b) =>
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
    if (r.decision === "error") continue;
    const decided = r.decision === "refusal" ? "null" : r.decision;
    if (decided === r.label) continue;
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
