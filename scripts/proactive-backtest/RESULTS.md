# Proactive interjection model backtest — 2026-07 results

Goal: replace `anthropic:claude-opus-4-5` as the proactive serious-stage model
with something modern, WITHOUT increasing the false-positive rate (unwanted
interjections — the most annoying failure mode), while limiting the increase
in false negatives (going silent where opus-4-5 would speak).

## Setup

- Dataset: 810 serious-stage decisions (584 interject / 226 NULL) extracted
  from production logs 2026-04-01..2026-07-17 (opus-4-5 decisions only; see
  README.md for method + caveats). Silver standard = opus-4-5's production
  decision.
- Dev subset: 60 null + 60 interject; finals: 226 null + 300 interject.
- Replay: single tool-less completion, reasoning=low.
- FP% = P(interject | silver NULL); FN% = P(NULL | silver interject).
  Refusals count as NULL but are tracked separately.
- **Calibration floor**: opus-4-5 replayed through the harness against its own
  production decisions gives FP 17.7 / FN 19.0 (full set) — pure harness noise
  (sampling variance + no tools). Candidates should be compared to that floor,
  not to 0/0.

## Dev-subset sweep (60+60), FP%/FN%

| model \ prompt        | logged (prod) | strict-v2 | strict-v3 | strict-v4 | strict-v1 |
|-----------------------|---------------|-----------|-----------|-----------|-----------|
| opus-4-5 (reference)  | 11.7 / 26.7   | 3.3 / 51.7| 8.3 / 60.0| —         | 1.7 / 73.3|
| opus-4-8              | 46.7 / 11.7   | 18.3 / 38.3| 16.7 / 46.7| 16.7 / 43.3| 6.7 / 75.0|
| fable-5 (~10% refusals)| 45.0 / 21.7  | 31.7 / 26.7| 30.0 / 31.7| 33.3 / 30.0| 8.3 / 56.7|
| glm-5.2               | 38.3 / 25.0   | 36.7 / 16.7| 35.0 / 11.7| —         | 11.7 / 59.3|
| gemini-3.5-flash      | 56.9 / 12.1   | 48.3 / 13.6| 48.3 / 18.3| —         | 8.3 / 65.0|

Findings:
- Pasky's observation confirmed: with the production prompt every modern
  candidate is 3-5x more trigger-happy than opus-4-5.
- Prompt strength is a powerful knob, but gemini/glm respond only to the
  extreme strict-v1 wording (which makes every model near-mute, opus-4-5
  included). opus-4-8 is by far the most steerable; fable-5 additionally
  burns ~10% of runs on refusals.

## Finals (226 null + 300 interject)

| run                    | FP%      | FN%      | p50 lat | cost/run |
|------------------------|----------|----------|---------|----------|
| opus-4-5 logged (floor)| 17.7 (40/226) | 19.0 (57/300) | 12.3s | $0.018 |
| **opus-4-8 strict-v2** | **19.5 (44/226)** | 33.0 (99/300) | 4.3s | $0.013 |
| opus-4-8 strict-v4     | 20.4 (46/226) | 37.0 (111/300) | 4.2s | $0.013 |

opus-4-8 + strict-v2 lands within statistical noise of the opus-4-5
calibration floor on FP (Δ1.8pp, SE≈3.7pp), i.e. it matches opus-4-5's
false-positive behavior, while being ~3x faster and ~30% cheaper per decision.
It goes silent moderately more often (FN 33% vs 19% floor) — the safe
direction of error.

## Recommendation (applied)

- `rooms.common.proactive.models.serious` → `anthropic:claude-opus-4-8`
- `rooms.common.proactive.prompts.seriousExtra` → `prompts/strict-v2.txt`

Not chosen: fable-5 (refusal overhead + FP not controllable below ~30%),
glm-5.2 / gemini-3.5-flash (FP only controllable via a prompt that induces
near-muteness; glm-5.2 + strict-v1 is a viable ultra-cheap fallback if cost
ever matters: FP 11.7 but FN ~59).

Experiment spend: ~$53.

## Refining further

`data/annotate-opus48-v2.md` holds the top-20 FP disagreements (opus-4-8-v2
spoke, opus-4-5 stayed silent) formatted for annotation — fill the `gold[...]`
lines and re-run report.ts with `--annotations` to score against human gold
instead of silver. If a chunk of those FPs are annotated `interject`/`either`,
the effective FP gap shrinks further.
