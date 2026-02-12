# TypeScript Runtime Operator Rollout (Milestone 7K)

This checklist governs the cutover from the Python service runtime to the TypeScript runtime (`cd ts && npm run start`) while keeping an explicit rollback window.

## Rollout window and rollback policy

- **Default runtime:** `MUADDIB_RUNTIME=ts`.
- **Rollback runtime:** `MUADDIB_RUNTIME=python`.
- **Rollback window closes:** `2026-03-31T23:59:59Z`.
- During rollback window, always verify resolved runtime before restart:
  - TS default: `MUADDIB_RUNTIME=ts docker compose config | rg MUADDIB_RUNTIME`
  - Python rollback: `MUADDIB_RUNTIME=python docker compose config | rg MUADDIB_RUNTIME`

## Preflight checklist

1. **Build artifacts available**
   - `cd ts && npm ci && npm run build`
2. **Config contract sanity**
   - deferred Python-only sections may remain in config (`chronicler.quests`, `quests`, `rooms.*.proactive`) but are ignored by TS unless explicitly enabled (`chronicler` core runtime is now supported)
   - TS fail-fast rejects explicitly enabled deferred sections (`enabled: true`) for those keys
   - startup/CLI logs include an ignored-warning line when deferred sections are present but inactive
3. **Provider credential contract sanity**
   - TS supports static `providers.<provider>.key` strings or provider env vars only
   - OAuth/session refresh config stays deferred (`providers.*.oauth`, `providers.*.session` rejected fail-fast)
4. **Room credential sanity**
   - IRC: `rooms.irc.varlink.socket_path`
   - Discord: `rooms.discord.token`
   - Slack: `rooms.slack.app_token` + per-workspace `bot_token`

## Runtime behavior parity notes (in-scope)

- Slack/Discord now include bounded 429 retries for outbound sends.
- Slack/Discord message edit events update persisted history by `platform_id`.
- Thread/reply mapping parity hardened:
  - Slack channel replies can default to thread start (`reply_start_thread.channel`)
  - Slack DM threading remains opt-in (`reply_start_thread.dm`)
  - Discord reply sends include explicit `replyToMessageId` + `mentionAuthor` behavior
- Mention/identity normalization parity hardened in Slack/Discord transports/monitors.
- Logging parity hardened for operator observability:
  - stdout emits INFO+ lifecycle lines with Python-style formatting (`timestamp - logger - LEVEL - message`)
  - TS writes daily system logs to `$MUADDIB_HOME/logs/YYYY-MM-DD/system.log`
  - TS routes direct/highlight message handling logs into Python-style message-sharded files:
    - `$MUADDIB_HOME/logs/YYYY-MM-DD/<arc-safe>/HH-MM-SS-<nick>-<preview>.log`
    - lifecycle markers (`Starting message log`, `Finished message log`) remain in `system.log`
  - parity reference semantics are mirrored from `muaddib/message_logging.py` (including preview/arc sanitization); TS intentionally does append-per-write without Python's file-handle LRU cache

## Deployment sequence

1. Deploy TS-capable image/runtime wrapper.
2. Set runtime env:
   - `MUADDIB_RUNTIME=ts` (default)
   - `MUADDIB_TS_ROLLBACK_UNTIL=2026-03-31T23:59:59Z`
3. Validate compose/runtime resolution before rollout:
   - `MUADDIB_RUNTIME=ts docker compose config | rg MUADDIB_RUNTIME`
4. Start canary rooms/workspaces.
5. Observe logs for retry/failure instrumentation and transport health.
   - retry/failure events: `[muaddib][send-retry]`
   - operator metric lines: `[muaddib][metric]`
   - startup/monitor lifecycle lines in stdout and `$MUADDIB_HOME/logs/YYYY-MM-DD/system.log`
   - per-message shard files produced for direct/highlight messages under:
     - `$MUADDIB_HOME/logs/YYYY-MM-DD/<arc-safe>/HH-MM-SS-<nick>-<preview>.log`
   - quick verification commands:
     - `find "$MUADDIB_HOME/logs/$(date +%F)" -mindepth 2 -maxdepth 2 -name "*.log" | head`
     - `rg -n "Starting message log:|Finished message log:" "$MUADDIB_HOME/logs/$(date +%F)/system.log"`
6. Expand to full deployment.

## Soak SLO guardrails (required during rollback window)

Track from runtime logs (`[muaddib][send-retry]` + `[muaddib][metric]`):

1. **Terminal send failure budget**
   - `type="failed"` events must stay **< 0.5% of outbound sends per 24h**, and
   - must not exceed **3 terminal failures for the same destination within 15 minutes**.
2. **Retry pressure budget**
   - `type="retry"` events must stay **< 5% of outbound sends per 24h**.
3. **Startup health budget**
   - no more than **1 startup contract failure** (bad config/credentials) per deployment change.

If any budget is breached and not mitigated within 30 minutes, trigger rollback.

## Required parity verification checks

Run at canary rollout, after every deploy, and daily during soak:

1. Discord direct mention -> successful reply (no terminal send failure).
2. Slack direct mention -> successful reply (no terminal send failure).
3. Slack channel reply starts/uses thread per `reply_start_thread.channel`.
4. Slack DM reply remains non-threaded unless `reply_start_thread.dm=true`.
5. Discord replies preserve `replyToMessageId` + `mentionAuthor` semantics.
6. Discord/Slack message edits update history records by `platform_id`.
7. IRC reconnect preserves direct-address detection (nick cache refresh behavior).

Any repeated parity failure (same check failing twice in a row) is a rollback trigger.

## Daily operator evidence checklist (rollback window)

Record one entry per day (and one entry per deploy) using:
- template: `docs/typescript-runtime-soak-evidence-template.md`
- execution log: `docs/typescript-runtime-soak-evidence-log.md`

Minimum evidence per entry:
1. Runtime verification for both paths:
   - `MUADDIB_RUNTIME=ts docker compose config | rg MUADDIB_RUNTIME`
   - `MUADDIB_RUNTIME=python docker compose config | rg MUADDIB_RUNTIME`
2. SLO values with source references (log query/dashboard snapshot links).
3. Parity-check pass/fail with concrete room/message references.
4. Explicit decision for the window:
   - stay on `MUADDIB_RUNTIME=ts` (default), or
   - rollback to `MUADDIB_RUNTIME=python` with incident reference.

Missing any required field in an entry is an **operational failure** for that window and must be escalated before deprecation-gate decisions.

## Rollback-window exit gate (Python deprecation readiness)

Python runtime deprecation is allowed only when all are true:

1. TS has run as default runtime for **at least 14 consecutive days**.
2. SLO guardrails above stayed within budget for the final **7 consecutive days**.
3. Required parity verification checks all pass for the final **7 consecutive days**.
4. No rollback to `MUADDIB_RUNTIME=python` was required during those final 7 days.

If the gate is not met by `2026-03-31T23:59:59Z`, keep Python rollback path enabled and extend the window.

## Success criteria

- No startup contract failures in production config.
- No sustained send failures after bounded retries.
- Message edit updates and thread/reply behavior validated on live Discord/Slack channels.
- No rollback required through the window.
