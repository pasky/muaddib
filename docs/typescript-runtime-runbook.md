# TypeScript Runtime Deployment + Rollback Runbook

## Objective

Run muaddib service on the TypeScript runtime by default, with explicit rollback path to Python until `2026-03-31T23:59:59Z`.

## Deploy (TS default)

### Docker Compose

1. Ensure env:
   - `MUADDIB_RUNTIME=ts`
   - `MUADDIB_TS_ROLLBACK_UNTIL=2026-03-31T23:59:59Z`
2. Validate resolved compose runtime before deploy:
   - `MUADDIB_RUNTIME=ts docker compose config | rg MUADDIB_RUNTIME`
3. Rebuild and restart:
   - `docker compose build muaddib`
   - `docker compose up -d muaddib`
4. Verify startup logs include:
   - `Runtime=ts service mode`

### Non-compose/systemd style

Use TS runtime entrypoint command:

```bash
cd /path/to/repo/ts
npm ci
npm run build
npm run start -- --config /path/to/config.json
```

## Deferred-feature config contract (TS runtime)

- Deferred Python-only sections may remain in config: `chronicler`, `chronicler.quests`, `quests`, `rooms.*.proactive`.
- TS runtime ignores these sections when they are present but not explicitly enabled.
- TS runtime fail-fast rejects explicitly enabled deferred sections (`enabled: true`) under those keys.
- When inactive deferred sections are present, startup/CLI emits an operator warning that they are being ignored.

## Operational checks after deploy

1. Bot connects to enabled rooms.
2. Direct mention replies succeed on Discord/Slack.
3. Slack/Discord edits update chat history records.
4. No repeated bounded-retry exhaustion on outbound send paths.
5. Retry/failure instrumentation is visible in deployment logs:
   - `[muaddib][send-retry]` structured event lines (warn on retry, error on terminal failure)
   - `[muaddib][metric]` structured counter lines per retry/failure event

## Soak SLO checks (during rollback window)

Evaluate every deployment and at least daily:

1. Terminal send failures (`type="failed"`) are < 0.5% of outbound sends per 24h.
2. Terminal send failures do not exceed 3 for same destination within 15 minutes.
3. Retry events (`type="retry"`) are < 5% of outbound sends per 24h.
4. Startup contract failures are <= 1 per deployment change.

## Mandatory parity checks (during soak)

1. Discord direct mention -> valid reply.
2. Slack direct mention -> valid reply.
3. Slack channel thread-start behavior matches `reply_start_thread.channel`.
4. Slack DM non-threaded default remains intact unless explicitly enabled.
5. Discord reply metadata (`replyToMessageId`, `mentionAuthor`) remains correct.
6. Discord/Slack edit events update history by `platform_id`.
7. IRC reconnect keeps direct-address detection correct.

## Daily evidence capture workflow (rollback window)

Use:
- `docs/typescript-runtime-soak-evidence-template.md` (entry template)
- `docs/typescript-runtime-soak-evidence-log.md` (append-only execution log)

Required per entry:
1. Runtime path proof (both commands captured in notes/output links):
   - `MUADDIB_RUNTIME=ts docker compose config | rg MUADDIB_RUNTIME`
   - `MUADDIB_RUNTIME=python docker compose config | rg MUADDIB_RUNTIME`
2. SLO measurements with source links.
3. Parity check outcomes with concrete room/message references.
4. Operator decision: continue TS default (`MUADDIB_RUNTIME=ts`) or execute Python rollback (`MUADDIB_RUNTIME=python`).

Missing any required field is an **operational failure** for that daily/deploy window and must be escalated.

## Rollback triggers

Rollback to Python runtime (`MUADDIB_RUNTIME=python`) when any of these is true and cannot be mitigated within 30 minutes:

- soak SLO breach from the thresholds above
- same parity check fails twice in a row
- startup contract failures block service start after one corrective attempt

## Rollback-window exit gate (for removing Python runtime path)

Do not remove Python runtime rollback path unless all are satisfied:

1. `MUADDIB_RUNTIME=ts` is default in production for at least 14 consecutive days.
2. Final 7 days stay within soak SLO thresholds.
3. Final 7 days pass all mandatory parity checks.
4. No rollback to `MUADDIB_RUNTIME=python` in those final 7 days.

## Rollback procedure

### Docker Compose rollback

1. Set runtime override:
   - `MUADDIB_RUNTIME=python`
2. Validate resolved compose runtime before restart:
   - `MUADDIB_RUNTIME=python docker compose config | rg MUADDIB_RUNTIME`
3. Restart service:
   - `docker compose up -d muaddib`
4. Verify log line:
   - `Runtime=python (rollback path)`

### Non-compose/systemd rollback

Switch service command to:

```bash
uv run python -m muaddib.main
```

Restart service and verify healthy reconnect.

## Post-rollback actions

1. Capture failing logs/config snapshot.
2. Open parity hardening issue with concrete failing room/message examples.
3. Add red tests in TS rewrite suite first, then implement deterministic fix.
