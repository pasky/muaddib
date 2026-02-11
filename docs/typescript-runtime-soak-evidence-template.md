# TypeScript Runtime Soak Evidence Template

Use this template during rollback window tracking (`MUADDIB_TS_ROLLBACK_UNTIL=2026-03-31T23:59:59Z`).

Runtime policy is fixed:
- default runtime: `MUADDIB_RUNTIME=ts`
- rollback runtime: `MUADDIB_RUNTIME=python`

Append completed entries to `docs/typescript-runtime-soak-evidence-log.md`.
Missing any required field in an entry is an **operational failure** for that window.

---

## Daily / post-deploy evidence entry template

Copy this block once per day (and once after each deploy):

```md
### Date: YYYY-MM-DD (UTC) | Operator: @name | Window: HH:MM-HH:MM UTC

#### Runtime path verification (required)
- TS default command/output: `MUADDIB_RUNTIME=ts docker compose config | rg MUADDIB_RUNTIME`
  - Evidence link/output: <paste>
- Python rollback command/output: `MUADDIB_RUNTIME=python docker compose config | rg MUADDIB_RUNTIME`
  - Evidence link/output: <paste>

#### Soak SLO evidence (required)
| Metric | Threshold | Observed | Source | Pass/Fail |
| --- | --- | --- | --- | --- |
| Terminal send failures (`type="failed"`) per 24h | < 0.5% of outbound sends | <fill> | <log query/dashboard> | <pass/fail> |
| Terminal failures for same destination in 15m | <= 3 | <fill> | <log query/dashboard> | <pass/fail> |
| Retry events (`type="retry"`) per 24h | < 5% of outbound sends | <fill> | <log query/dashboard> | <pass/fail> |
| Startup contract failures per deploy | <= 1 | <fill> | <deploy logs> | <pass/fail> |

#### Mandatory parity checks (required)
- [ ] Discord direct mention -> valid reply (evidence: <room/message/log>)
- [ ] Slack direct mention -> valid reply (evidence: <room/message/log>)
- [ ] Slack channel thread behavior matches `reply_start_thread.channel` (evidence: <room/message/log>)
- [ ] Slack DM remains non-threaded unless `reply_start_thread.dm=true` (evidence: <room/message/log>)
- [ ] Discord reply metadata keeps `replyToMessageId` + `mentionAuthor` semantics (evidence: <room/message/log>)
- [ ] Discord/Slack edit events update history by `platform_id` (evidence: <room/message/log/db query>)
- [ ] IRC reconnect keeps direct-address detection correct (evidence: <room/message/log>)

#### Decision and incident tracking (required)
- Decision:
  - [ ] Stay on TS default (`MUADDIB_RUNTIME=ts`)
  - [ ] Roll back to Python (`MUADDIB_RUNTIME=python`)
- If rollback selected: incident link + trigger + mitigation summary: <fill>
- Notes / follow-up actions: <fill>
```

---

## Final exit-gate tracking (7-day final gate)

Use this summary table for the final 7-day deprecation gate window:

```md
| Day | TS default runtime verified | SLOs pass | All parity checks pass | Rollback avoided |
| --- | --- | --- | --- | --- |
| Day 1 | <yes/no> | <yes/no> | <yes/no> | <yes/no> |
| Day 2 | <yes/no> | <yes/no> | <yes/no> | <yes/no> |
| Day 3 | <yes/no> | <yes/no> | <yes/no> | <yes/no> |
| Day 4 | <yes/no> | <yes/no> | <yes/no> | <yes/no> |
| Day 5 | <yes/no> | <yes/no> | <yes/no> | <yes/no> |
| Day 6 | <yes/no> | <yes/no> | <yes/no> | <yes/no> |
| Day 7 | <yes/no> | <yes/no> | <yes/no> | <yes/no> |
```

Exit gate can pass only if all 7 days are fully green and no rollback to `MUADDIB_RUNTIME=python` occurred in that window.
