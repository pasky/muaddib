# TypeScript Runtime Soak Evidence Log

This log is the execution record for daily and post-deploy rollback-window checks.

- Source template: `docs/typescript-runtime-soak-evidence-template.md`
- Rollback policy docs:
  - `docs/typescript-runtime-rollout.md`
  - `docs/typescript-runtime-runbook.md`

> Missing required evidence fields are an **operational failure** and must be escalated in the same window.

---

## Entries

### Date: 2026-02-11 (UTC) | Operator: @pi-agent | Window: 00:29-00:50 UTC

#### Runtime path verification (required)
- TS default command/output: `MUADDIB_RUNTIME=ts docker compose config | rg MUADDIB_RUNTIME`
  - Evidence output:
    ```
    MUADDIB_RUNTIME: ts
    ```
- Python rollback command/output: `MUADDIB_RUNTIME=python docker compose config | rg MUADDIB_RUNTIME`
  - Evidence output:
    ```
    MUADDIB_RUNTIME: python
    ```

#### Soak SLO evidence (required)
| Metric | Threshold | Observed | Source | Pass/Fail |
| --- | --- | --- | --- | --- |
| Terminal send failures (`type="failed"`) per 24h | < 0.5% of outbound sends | Missing live-room telemetry in this repo session | N/A (no production log query attached) | **Fail** |
| Terminal failures for same destination in 15m | <= 3 | Missing live-room telemetry in this repo session | N/A (no production log query attached) | **Fail** |
| Retry events (`type="retry"`) per 24h | < 5% of outbound sends | Missing live-room telemetry in this repo session | N/A (no production log query attached) | **Fail** |
| Startup contract failures per deploy | <= 1 | 0 observed in this validation window | local validation outputs (typecheck/tests/smoke) | Pass |

#### Mandatory parity checks (required)
- [ ] Discord direct mention -> valid reply (live evidence not attached)
- [ ] Slack direct mention -> valid reply (live evidence not attached)
- [ ] Slack channel thread behavior matches `reply_start_thread.channel` (live evidence not attached)
- [ ] Slack DM remains non-threaded unless `reply_start_thread.dm=true` (live evidence not attached)
- [ ] Discord reply metadata keeps `replyToMessageId` + `mentionAuthor` semantics (live evidence not attached)
- [ ] Discord/Slack edit events update history by `platform_id` (live evidence not attached)
- [ ] IRC reconnect keeps direct-address detection correct (live evidence not attached)

#### Decision and incident tracking (required)
- Decision:
  - [x] Stay on TS default (`MUADDIB_RUNTIME=ts`)
  - [ ] Roll back to Python (`MUADDIB_RUNTIME=python`)
- If rollback selected: incident link + trigger + mitigation summary: N/A
- Notes / follow-up actions:
  - This is the 7K bootstrap entry to start the evidence log.
  - Operational evidence is incomplete (SLO + live parity evidence missing), which is tracked as an operational failure for this window.
  - Next operator window must attach live-room log/dashboard queries and concrete room/message references.

### Date: 2026-02-11 (UTC) | Operator: @pi-agent | Window: 00:40-00:43 UTC (post-deploy validation)

#### Runtime path verification (required)
- TS default command/output: `MUADDIB_RUNTIME=ts docker compose config | rg MUADDIB_RUNTIME`
  - Evidence output:
    ```
    MUADDIB_RUNTIME: ts
    ```
- Python rollback command/output: `MUADDIB_RUNTIME=python docker compose config | rg MUADDIB_RUNTIME`
  - Evidence output:
    ```
    MUADDIB_RUNTIME: python
    ```

#### Soak SLO evidence (required)
| Metric | Threshold | Observed | Source | Pass/Fail |
| --- | --- | --- | --- | --- |
| Terminal send failures (`type="failed"`) per 24h | < 0.5% of outbound sends | Missing live-room telemetry in this repo session (`logs/` contains only `.keep`) | `find logs -maxdepth 1 -type f | sort`; `rg -n "\[muaddib\]\[(send-retry|metric)\]" logs` | **Fail** |
| Terminal failures for same destination in 15m | <= 3 | Missing live-room telemetry in this repo session (`logs/` contains only `.keep`) | `find logs -maxdepth 1 -type f | sort`; `rg -n "\[muaddib\]\[(send-retry|metric)\]" logs` | **Fail** |
| Retry events (`type="retry"`) per 24h | < 5% of outbound sends | Missing live-room telemetry in this repo session (`logs/` contains only `.keep`) | `find logs -maxdepth 1 -type f | sort`; `rg -n "\[muaddib\]\[(send-retry|metric)\]" logs` | **Fail** |
| Startup contract failures per deploy | <= 1 | 0 observed in this validation window | `cd ts && npm run typecheck`; `cd ts && npm test`; `uv run pytest`; `MUADDIB_HOME=. uv run muaddib --message "milestone 7l ts parity hardening smoke test"`; `pre-commit run --all-files` | Pass |

#### Mandatory parity checks (required)
- [ ] Discord direct mention -> valid reply (live evidence not attached)
- [ ] Slack direct mention -> valid reply (live evidence not attached)
- [ ] Slack channel thread behavior matches `reply_start_thread.channel` (live evidence not attached)
- [ ] Slack DM remains non-threaded unless `reply_start_thread.dm=true` (live evidence not attached)
- [ ] Discord reply metadata keeps `replyToMessageId` + `mentionAuthor` semantics (live evidence not attached)
- [ ] Discord/Slack edit events update history by `platform_id` (live evidence not attached)
- [ ] IRC reconnect keeps direct-address detection correct (live evidence not attached)

#### Decision and incident tracking (required)
- Decision:
  - [x] Stay on TS default (`MUADDIB_RUNTIME=ts`)
  - [ ] Roll back to Python (`MUADDIB_RUNTIME=python`)
- If rollback selected: incident link + trigger + mitigation summary: N/A
- Notes / follow-up actions:
  - No newly observed concrete live Slack/Discord/IRC regressions in this window; no red tests/runtime fixes added.
  - Operational evidence remains incomplete (missing production SLO and live parity room/message evidence), so this window is still an operational failure.
  - Python rollback path remains enabled; final 7-day gate is still not met.

### Date: 2026-02-11 (UTC) | Operator: @pi-agent | Window: 01:45-01:47 UTC (post-deploy validation continuation)

#### Runtime path verification (required)
- TS default command/output: `MUADDIB_RUNTIME=ts docker compose config | rg MUADDIB_RUNTIME`
  - Evidence output:
    ```
    MUADDIB_RUNTIME: ts
    ```
- Python rollback command/output: `MUADDIB_RUNTIME=python docker compose config | rg MUADDIB_RUNTIME`
  - Evidence output:
    ```
    MUADDIB_RUNTIME: python
    ```

#### Soak SLO evidence (required)
| Metric | Threshold | Observed | Source | Pass/Fail |
| --- | --- | --- | --- | --- |
| Terminal send failures (`type="failed"`) per 24h | < 0.5% of outbound sends | Missing production telemetry in this repo session (`logs/` contains only `.keep`) | `find logs -maxdepth 1 -type f | sort`; `rg -n "\[muaddib\]\[(send-retry|metric)\]" logs` | **Fail** |
| Terminal failures for same destination in 15m | <= 3 | Missing production telemetry in this repo session (`logs/` contains only `.keep`) | `find logs -maxdepth 1 -type f | sort`; `rg -n "\[muaddib\]\[(send-retry|metric)\]" logs` | **Fail** |
| Retry events (`type="retry"`) per 24h | < 5% of outbound sends | Missing production telemetry in this repo session (`logs/` contains only `.keep`) | `find logs -maxdepth 1 -type f | sort`; `rg -n "\[muaddib\]\[(send-retry|metric)\]" logs` | **Fail** |
| Startup contract failures per deploy | <= 1 | 0 observed in this validation window | `cd ts && npm run typecheck`; `cd ts && npm test`; `uv run pytest`; `MUADDIB_HOME=. uv run muaddib --message "milestone 7l ts parity hardening smoke test"`; `pre-commit run --all-files` | Pass |

#### Mandatory parity checks (required)
- [ ] Discord direct mention -> valid reply (live evidence not attached)
- [ ] Slack direct mention -> valid reply (live evidence not attached)
- [ ] Slack channel thread behavior matches `reply_start_thread.channel` (live evidence not attached)
- [ ] Slack DM remains non-threaded unless `reply_start_thread.dm=true` (live evidence not attached)
- [ ] Discord reply metadata keeps `replyToMessageId` + `mentionAuthor` semantics (live evidence not attached)
- [ ] Discord/Slack edit events update history by `platform_id` (live evidence not attached)
- [ ] IRC reconnect keeps direct-address detection correct (live evidence not attached)

#### Decision and incident tracking (required)
- Decision:
  - [x] Stay on TS default (`MUADDIB_RUNTIME=ts`)
  - [ ] Roll back to Python (`MUADDIB_RUNTIME=python`)
- If rollback selected: incident link + trigger + mitigation summary: N/A
- Notes / follow-up actions:
  - No newly observed concrete live Slack/Discord/IRC regressions in this window; no red tests/runtime fixes added.
  - Production SLO/parity evidence is still missing in this repo-only session, so this window remains an operational failure.
  - Python rollback path remains enabled; final 7-day gate is still not met.

### Date: 2026-02-11 (UTC) | Operator: @pi-agent | Window: 01:50-01:53 UTC (post-deploy validation continuation)

#### Runtime path verification (required)
- TS default command/output: `MUADDIB_RUNTIME=ts docker compose config | rg MUADDIB_RUNTIME`
  - Evidence output:
    ```
    MUADDIB_RUNTIME: ts
    ```
- Python rollback command/output: `MUADDIB_RUNTIME=python docker compose config | rg MUADDIB_RUNTIME`
  - Evidence output:
    ```
    MUADDIB_RUNTIME: python
    ```

#### Soak SLO evidence (required)
| Metric | Threshold | Observed | Source | Pass/Fail |
| --- | --- | --- | --- | --- |
| Terminal send failures (`type="failed"`) per 24h | < 0.5% of outbound sends | Missing production telemetry in this repo session (`logs/` contains only `.keep`) | `find logs -maxdepth 1 -type f | sort`; `rg -n "\[muaddib\]\[(send-retry|metric)\]" logs` | **Fail** |
| Terminal failures for same destination in 15m | <= 3 | Missing production telemetry in this repo session (`logs/` contains only `.keep`) | `find logs -maxdepth 1 -type f | sort`; `rg -n "\[muaddib\]\[(send-retry|metric)\]" logs` | **Fail** |
| Retry events (`type="retry"`) per 24h | < 5% of outbound sends | Missing production telemetry in this repo session (`logs/` contains only `.keep`) | `find logs -maxdepth 1 -type f | sort`; `rg -n "\[muaddib\]\[(send-retry|metric)\]" logs` | **Fail** |
| Startup contract failures per deploy | <= 1 | 0 observed in this validation window | `cd ts && npm run typecheck`; `cd ts && npm test`; `uv run pytest`; `MUADDIB_HOME=. uv run muaddib --message "milestone 7l ts parity hardening smoke test"`; `pre-commit run --all-files` | Pass |

#### Mandatory parity checks (required)
- [ ] Discord direct mention -> valid reply (live evidence not attached)
- [ ] Slack direct mention -> valid reply (live evidence not attached)
- [ ] Slack channel thread behavior matches `reply_start_thread.channel` (live evidence not attached)
- [ ] Slack DM remains non-threaded unless `reply_start_thread.dm=true` (live evidence not attached)
- [ ] Discord reply metadata keeps `replyToMessageId` + `mentionAuthor` semantics (live evidence not attached)
- [ ] Discord/Slack edit events update history by `platform_id` (live evidence not attached)
- [ ] IRC reconnect keeps direct-address detection correct (live evidence not attached)

#### Decision and incident tracking (required)
- Decision:
  - [x] Stay on TS default (`MUADDIB_RUNTIME=ts`)
  - [ ] Roll back to Python (`MUADDIB_RUNTIME=python`)
- If rollback selected: incident link + trigger + mitigation summary: N/A
- Notes / follow-up actions:
  - Live-soak regression intake in this window found no newly observed concrete Slack/Discord/IRC runtime regressions.
  - Production SLO and live parity evidence remain missing in this repo-only session, so this window is an operational failure.
  - Python rollback path remains enabled; final 7-day gate is still not met.

### Date: 2026-02-11 (UTC) | Operator: @pi-agent | Window: 01:54-01:56 UTC (post-deploy validation continuation)

#### Runtime path verification (required)
- TS default command/output: `MUADDIB_RUNTIME=ts docker compose config | rg MUADDIB_RUNTIME`
  - Evidence output:
    ```
    MUADDIB_RUNTIME: ts
    ```
- Python rollback command/output: `MUADDIB_RUNTIME=python docker compose config | rg MUADDIB_RUNTIME`
  - Evidence output:
    ```
    MUADDIB_RUNTIME: python
    ```

#### Soak SLO evidence (required)
| Metric | Threshold | Observed | Source | Pass/Fail |
| --- | --- | --- | --- | --- |
| Terminal send failures (`type="failed"`) per 24h | < 0.5% of outbound sends | Missing production telemetry in this repo session (`logs/` contains only `.keep`; no `[muaddib][send-retry|metric]` lines found) | `find logs -maxdepth 1 -type f | sort`; `rg -n "\[muaddib\]\[(send-retry|metric)\]" logs` | **Fail** |
| Terminal failures for same destination in 15m | <= 3 | Missing production telemetry in this repo session (`logs/` contains only `.keep`; no `[muaddib][send-retry|metric]` lines found) | `find logs -maxdepth 1 -type f | sort`; `rg -n "\[muaddib\]\[(send-retry|metric)\]" logs` | **Fail** |
| Retry events (`type="retry"`) per 24h | < 5% of outbound sends | Missing production telemetry in this repo session (`logs/` contains only `.keep`; no `[muaddib][send-retry|metric]` lines found) | `find logs -maxdepth 1 -type f | sort`; `rg -n "\[muaddib\]\[(send-retry|metric)\]" logs` | **Fail** |
| Startup contract failures per deploy | <= 1 | 0 observed in this validation window | `cd ts && npm run typecheck`; `cd ts && npm test`; `uv run pytest`; `MUADDIB_HOME=. uv run muaddib --message "milestone 7l ts parity hardening smoke test"`; `pre-commit run --all-files` | Pass |

#### Mandatory parity checks (required)
- [ ] Discord direct mention -> valid reply (live evidence not attached)
- [ ] Slack direct mention -> valid reply (live evidence not attached)
- [ ] Slack channel thread behavior matches `reply_start_thread.channel` (live evidence not attached)
- [ ] Slack DM remains non-threaded unless `reply_start_thread.dm=true` (live evidence not attached)
- [ ] Discord reply metadata keeps `replyToMessageId` + `mentionAuthor` semantics (live evidence not attached)
- [ ] Discord/Slack edit events update history by `platform_id` (live evidence not attached)
- [ ] IRC reconnect keeps direct-address detection correct (live evidence not attached)

#### Decision and incident tracking (required)
- Decision:
  - [x] Stay on TS default (`MUADDIB_RUNTIME=ts`)
  - [ ] Roll back to Python (`MUADDIB_RUNTIME=python`)
- If rollback selected: incident link + trigger + mitigation summary: N/A
- Notes / follow-up actions:
  - Live-soak regression intake in this window found no newly observed concrete Slack/Discord/IRC runtime regressions.
  - Production SLO and live parity evidence remain missing in this repo-only session, so this window is an operational failure.
  - Python rollback path remains enabled; final 7-day gate is still not met.

---

## Final exit-gate tracking (7-day final gate)

| Day | TS default runtime verified | SLOs pass | All parity checks pass | Rollback avoided |
| --- | --- | --- | --- | --- |
| Day 1 | yes | no | no | yes |
| Day 2 | no | no | no | no |
| Day 3 | no | no | no | no |
| Day 4 | no | no | no | no |
| Day 5 | no | no | no | no |
| Day 6 | no | no | no | no |
| Day 7 | no | no | no | no |

Gate status: **NOT MET** (final 7-day window not yet green).
