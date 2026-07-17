# Proactive interjection backtest

Infra for evaluating candidate models/prompts for the proactive interjection
**serious stage** — the agent run that either posts an interjection or responds
with the `NULL` sentinel (see `src/rooms/command/proactive.ts` +
`CommandExecutor.executeQuiet`). The production model's logged decisions form a
**silver standard**: `claude-opus-4-5` has ~no false positives per pasky, so
candidate FP rate (interjecting where opus-4-5 said NULL) is the key metric.
False negatives (going silent where opus-4-5 spoke) are the secondary metric.

## Method notes

- Dataset is extracted from `$MUADDIB_HOME/logs/<date>/<arc>/*-proactive-*.log`
  debug logs: only sessions that passed validation ("Interjecting proactively")
  and ended in an unambiguous decision (delivered response, or explicit NULL
  sentinel). Errors/truncated sessions are skipped. Decisions made by other
  models (e.g. a brief opus-4-7 stint) are excluded.
- Replay is a single **tool-less** completion with the logged system prompt
  truncated at the runner-appended workspace section (`Filesystem:` onwards).
  Production runs are full agent sessions with tools; tool access mostly
  affects response *content*, not the interject-vs-NULL decision. To calibrate
  this harness gap, re-run the silver model itself through the harness and
  compare candidates against its in-harness rates, not against 0/0.
- Refusals (relevant for e.g. claude-fable-5) are detected via
  `src/agent/refusal-detection.ts` and scored as NULL decisions (production
  must suppress them the same way), but reported separately — a high refusal
  rate is still bad (latency, cost, and it needs `refusalFallbackModel`
  handling to not leak error text).

## Workflow

```sh
# 1. Extract dataset (silver labels from production opus-4-5 decisions)
npx tsx scripts/proactive-backtest/extract.ts \
  --logs ~/.muaddib-profiles/MuaddibLLM/logs --from 2026-04-01 \
  --out scripts/proactive-backtest/data/dataset.jsonl

# 2. Run a candidate (dev subset: --max-null 60 --max-interject 60;
#    omit caps for a full run). Results append + resume on rerun.
npx tsx scripts/proactive-backtest/run.ts \
  --dataset scripts/proactive-backtest/data/dataset.jsonl \
  --auth ~/.muaddib-profiles/MuaddibLLM/auth.json \
  --model anthropic:claude-fable-5 --reasoning low \
  --max-null 60 --max-interject 60
# Optional: --prompt prompts/<variant>.txt replaces the "NOTE: This is a
# proactive interjection..." tail of the system prompt (the seriousExtra).

# 3. Score all runs (sorted by FP rate)
npx tsx scripts/proactive-backtest/report.ts \
  --dataset scripts/proactive-backtest/data/dataset.jsonl \
  scripts/proactive-backtest/results/*.jsonl

# 4. Optionally generate an annotation sheet for a run's disagreements,
#    fill in the gold[...] lines, and feed back via --annotations
npx tsx scripts/proactive-backtest/report.ts \
  --dataset scripts/proactive-backtest/data/dataset.jsonl \
  --disagreements-for scripts/proactive-backtest/results/<run>.jsonl \
  scripts/proactive-backtest/results/<run>.jsonl
```

`data/` and `results/` are gitignored (chat logs are private); the dataset is
reproducible from the profile logs via extract.ts.
