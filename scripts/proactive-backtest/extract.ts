#!/usr/bin/env npx tsx
/**
 * Extract a proactive-interjection backtest dataset from muaddib debug logs.
 *
 * Scans MUADDIB_HOME-style logs/<YYYY-MM-DD>/<arc>/<HH-MM-SS>-proactive-*.log
 * for serious-stage runs that passed validation ("Interjecting proactively"),
 * and labels each with the production model's decision (silver standard):
 * delivered response → "interject", explicit NULL sentinel → "null".
 * Ambiguous sessions (errors, truncation) are skipped and counted.
 *
 * Usage:
 *   npx tsx scripts/proactive-backtest/extract.ts \
 *     --logs ~/.muaddib-profiles/MuaddibLLM/logs --from 2026-04-01 \
 *     --out scripts/proactive-backtest/data/dataset.jsonl
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import { extractExample, type DatasetExample, type ExtractSkip } from "./lib.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const logsRoot = argValue("--logs");
const out = argValue("--out");
const from = argValue("--from") ?? "0000-00-00";
const to = argValue("--to") ?? "9999-99-99";
/** Only decisions by this model constitute the silver standard. */
const silverModel = argValue("--silver-model") ?? "claude-opus-4-5";
if (!logsRoot || !out) {
  console.error("Usage: extract.ts --logs <logsdir> --out <dataset.jsonl> [--from YYYY-MM-DD] [--to YYYY-MM-DD]");
  process.exit(1);
}

const examples: DatasetExample[] = [];
const skips: ExtractSkip[] = [];

const dateDirs = readdirSync(logsRoot)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= from && d <= to)
  .sort();

for (const date of dateDirs) {
  const dateDir = join(logsRoot, date);
  if (!statSync(dateDir).isDirectory()) continue;
  for (const arcDir of readdirSync(dateDir).sort()) {
    const arcPath = join(dateDir, arcDir);
    if (!statSync(arcPath).isDirectory()) continue;
    for (const file of readdirSync(arcPath).sort()) {
      if (!file.includes("-proactive-") || !file.endsWith(".log")) continue;
      const id = `${date}/${arcDir}/${file}`;
      const text = readFileSync(join(arcPath, file), "utf8");
      if (!text.includes("Interjecting proactively")) continue; // validation didn't pass — not a serious-stage case
      const { example, skip } = extractExample(text, id);
      if (example && example.silverModel !== silverModel) {
        skips.push({ id, reason: `silver-model-${example.silverModel}` });
      } else if (example) {
        examples.push(example);
      } else if (skip) {
        skips.push(skip);
      }
    }
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, examples.map((e) => JSON.stringify(e)).join("\n") + "\n");

const byLabel: Record<string, number> = {};
for (const e of examples) byLabel[e.label] = (byLabel[e.label] ?? 0) + 1;
const bySilverModel: Record<string, number> = {};
for (const e of examples) bySilverModel[e.silverModel] = (bySilverModel[e.silverModel] ?? 0) + 1;
const bySkipReason: Record<string, number> = {};
for (const s of skips) bySkipReason[s.reason] = (bySkipReason[s.reason] ?? 0) + 1;

console.log(`Extracted ${examples.length} examples → ${out}`);
console.log(`Labels: ${JSON.stringify(byLabel)}`);
console.log(`Silver models: ${JSON.stringify(bySilverModel)}`);
console.log(`Skipped ${skips.length}: ${JSON.stringify(bySkipReason)}`);
for (const s of skips) console.log(`  skip ${s.reason} ${s.id}`);
