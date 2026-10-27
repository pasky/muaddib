# Proactive interjection model backtest — 2026-07 results

Goal: replace `anthropic:claude-opus-4-5` as the proactive serious-stage model
with something modern, WITHOUT increasing the false-positive rate (unwanted
interjections — the most annoying failure mode), while limiting the increase
in false negatives (going silent where opus-4-5 would speak).

## Setup

- Dataset: 809 serious-stage decisions (582 interject / 227 NULL) extracted
  from production logs 2026-04-01..2026-07-17 (opus-4-5 decisions only; see
  README.md for method + caveats). Silver standard = opus-4-5's production
  decision. (Regenerated post-review to exclude 2 sessions decided by a
  refusal-fallback model; neither had been sampled into any published run,
  so all numbers below stand.)
- Dev subset: 60 null + 60 interject; finals: 226 null + 300 interject.
- Replay: single tool-less completion, reasoning=low. This differs from
  production (full agent session with tools, memory, skills; ~40% of logged
  sessions used tools before deciding), so all rates below are **silver-label
  disagreement rates under harness shift**, not true production FP/FN rates.
- FP% = P(interject | silver NULL); FN% = P(NULL | silver interject).
  Refusals count as NULL but are tracked separately (note: production
  currently retries refusals via `refusalFallbackModels`, which could itself
  interject — deploying a refusal-prone model would need that suppressed for
  proactive runs).
- **Replay baseline**: opus-4-5 replayed through the harness against its own
  production decisions gives FP 17.7 / FN 19.0 (full set). That gap bundles
  sampling nondeterminism *and* the systematic harness shift; candidates are
  compared against this baseline, not against 0/0.

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

Because dev cases are a (nested) subset of the finals, the honest comparison
is on the 406 held-out cases never used for prompt selection: there
**opus-4-8+strict-v2 and the opus-4-5 replay baseline have identical FP,
33/166 (19.9%)** (paired discordance on those 166 held-out NULLs: 19
baseline-only vs 19 candidate-only — no detectable difference). No equivalence
margin was pre-registered, so the claim is "no detected FP regression", not
proven equivalence. FN on held-out: 31.7% vs 17.1% baseline — it goes silent
moderately more often, the safe direction of error. Replay latency/cost
(~3x faster, ~30% cheaper than opus-4-5 replay) are indicative only, as
production runs include tool use.

## Annotation round (2026-07-17)

pasky annotated the top-20 FP-type disagreements of opus-4-8+v2 (sheet now at
`~/.muaddib-profiles/MuaddibLLM/backtest-proactive-2026-07/annotate-opus48-v2.md`):
**8 interject / 9 either / 3 null** — i.e. only 3/20 of the candidate's
alleged FPs were genuinely bad, 8 were production opus-4-5's own missed
interjections, 9 don't matter. Gold-adjusted full-set scores:

| run                    | FP% (gold)   | FN% (silver, one-sided¹) |
|------------------------|--------------|--------------------------|
| opus-4-8 strict-v5     | **12.0** (25/209) | 42.9² (132/308)     |
| opus-4-8 strict-v2     | 12.9 (27/209)| 32.1 (99/308)            |
| opus-4-5 replay        | 16.3 (34/209)| 20.1 (62/308)            |

¹ FN-type disagreements were not annotated (sheet ready at
`annotate-opus48-v2-FN.md`), so FN rates still take silver at face value —
the same silver-error effect would likely shrink the FN gap too.
² strict-v5 adds a check: on fast-moving topics (LLMs, tooling, prices),
verify with live search before interjecting, else NULL (pasky's suggestion
after annotating stale-tech-answer FPs — it flips 2 of the 3 gold-null cases
to NULL). Caveats: this is in-sample evidence (the prompt was written after
inspecting those very cases, and its 25-vs-27 FP edge over v2 is not
significant), and the harness has no tools, so "search first" can only
resolve to NULL here — in-harness FN is an upper bound and the tool-enabled
behavior is untested by this backtest. v5 adoption is therefore a
**production canary based on pasky's explicit preference**, not a
backtest-proven improvement; strict-v2 is the evidence-backed fallback if
production proves too quiet (or if search-spam becomes an issue).

All three gold-null FPs were confident-but-outdated tech answers — the most
egregious FP flavor (unprompted + wrong).

## Recommendation (applied)

- `rooms.common.proactive.models.serious` → `anthropic:claude-opus-4-8`
- `rooms.common.proactive.prompts.seriousExtra` → `prompts/strict-v5.txt`
  (strict-v2 + live-search check for fast-moving topics; fall back to
  `strict-v2.txt` if production proves too quiet)

In practice (108-day dataset, ~8 channels): production opus-4-5 interjected
~5.4x/day; the opus-4-5 tool-less replay ~4.8x/day; opus-4-8+v2 replay
~4.0x/day; opus-4-8+v5 replay ~3.5x/day (production will land above this
since tools recover part of check-5's NULLs).

Applied to `config.json.example` (template for new installs) and to the live
`~/.muaddib-profiles/MuaddibLLM/config.json` (backup:
`config.json.bak-interject-backtest`; takes effect on restart).

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

# 2026-10: claude-opus-5-5 (the `!a` model) as opus-4-8 replacement

Same protocol as July: July dataset (opus-4-5 silver), seed `backtest-v1`,
reasoning=low, tool-less replay, dev 60+60 prompt sweep → finals 226+300 →
held-out complement + gold, refusals tracked separately (scored as NULL).
Results under `$BACKTEST_DIR/results/anthropic_claude-opus-5-5-*`.

## Dev subset (60+60), FP%/FN% (refusals in parens)

| model    | logged         | strict-v1 | strict-v2 | strict-v3 | strict-v4  | strict-v5  |
|----------|----------------|-----------|-----------|-----------|------------|------------|
| opus-4-8 | 46.7 / 11.7    | 6.7 / 75.0| 18.3 / 38.3| 16.7 / 46.7| 16.7 / 43.3| 16.7 / 55.0|
| opus-5-5 | 33.3 / 26.7 (10)| 1.7 / 78.3| 26.7 / 28.3 (1)| 23.3 / 40.0| 28.3 / 33.3 (2)| 20.0 / 45.0 (1)|

opus-5-5 is less trigger-happy than 4-8 with the loose logged prompt but
*less* steerable by the strict prompts: at every strict-v2..v5 level it sits
~4-10pp FP above opus-4-8.

## Finals (226 null + 300 interject)

| run                | FP% silver    | FP% gold¹    | FN% silver     | refusals | p50 lat | cost/run |
|--------------------|---------------|--------------|----------------|----------|---------|----------|
| opus-4-8 v5 (prod) | 15.9 (36/226) | 12.0 (25/209)| 43.0 (129/300) | 0        | 4.1s    | $0.013   |
| opus-4-8 v2        | 19.5 (44/226) | 12.9 (27/209)| 33.0 (99/300)  | 0        | 4.3s    | $0.013   |
| opus-4-5 replay    | 17.7 (40/226) | 16.3 (34/209)| 19.0 (57/300)  | 0        | 12.3s   | $0.018   |
| **opus-5-5 v5**    | 20.4 (46/226) | 17.6 (37/210)| 44.3 (133/300) | 10 (1.9%)| 4.4s    | $0.012   |
| opus-5-5 v2        | 27.4 (62/226) | 23.8 (50/210)| 27.0 (81/300)  | 10 (1.9%)| 5.1s    | $0.012   |

¹ Gold = July's 20 annotations, which only adjudicated opus-4-8-v2's own FP
disagreements — structurally biased toward opus-4-8. Use silver for the
head-to-head.

Held-out (406 non-dev) silver FP: opus-5-5 v5 20.5% (34/166) vs opus-4-8 v5
15.7% (26/166). Paired on silver-NULL cases: 5-5-v5-only interjections 28 vs
4-8-v5-only 18 (McNemar p≈0.18, not significant); v2 vs v2 32 vs 13
(p≈0.007, significant).

## Fresh data cross-check (2026-07-18..10-27, silver = production opus-4-8+v5)

484 cases (107 null / 377 interject), `backtest-proactive-2026-10/`. Silver
is opus-4-8 itself, so its replay is self-agreement-advantaged; still:

| run             | FP%           | FN%            | refusals    |
|-----------------|---------------|----------------|-------------|
| opus-4-8 v5     | 9.3 (10/107)  | 18.8 (71/377)  | 2           |
| opus-5-5 v5     | 23.4 (25/107) | 27.9 (105/377) | 33 (6.8%)   |

Paired silver-NULL: 5-5-only 21 vs 4-8-only 6.

## Refusals

opus-5-5 refusals are of two kinds: (a) Anthropic ToS "reverse engineering /
duplicating model outputs" blocks on ordinary #llm discussion (agentic coding,
SAEs, quantization, even "what is a certificate"), and (b) the bio/chem
classifier on benign #hplusroadmap / ##biology / ##chemistry questions
(ancient DNA, polygenic scores, OSKM, gerozymes). Rate is 1.9% on Apr-Jul
data but 6.8% on Aug-Oct — rising with the #llm share. In production a
refusal falls through the `!a` mode stage (opus-5, kimi-k3) and the global
chain (deepseek-v4-pro), so those turns would be decided by un-backtested
models, plus latency/cost of the double call.

## Quality

Eyeballing the 28 cases where opus-5-5 alone interjected (both opus-4-5 and
opus-4-8 silent): mostly substantive, specific, plausible corrections/answers
(PostgREST for nginx-postgres RPC, RLS-vs-function-grants caveat, Discord CDN
signed-URL expiry causing zero-byte downloads, Ollama binding to 127.0.0.1,
Atkinson-cycle corrections) — like July, many silver "FPs" look like good
interjections. Unadjudicated: `annotate-opus55-v5.md` holds its 36 FP
disagreements not covered by the July gold sheet.

## Verdict

Do not switch yet. opus-5-5 is no better on FN, ~4-5pp worse on silver FP
(not significant on the July data, clearly worse on fresh data), and adds a
1.9-6.8% refusal rate that production routes to untested fallback models. Cost
and latency are a wash. Revisit if pasky's annotation of
`annotate-opus55-v5.md` shows most of its extra interjections are welcome
(then the FP gap could vanish as with 4-8 in July) AND proactive refusals
are suppressed (empty refusalFallbackModels for proactive) rather than
falling back.

Experiment spend: ~$32.
