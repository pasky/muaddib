# TypeScript Runtime Operator Rollout (Milestone 7G)

This checklist governs the cutover from the Python service runtime to the TypeScript runtime (`cd ts && npm run start`) while keeping an explicit rollback window.

## Rollout window and rollback policy

- **TS default runtime starts now**.
- **Rollback window closes:** `2026-03-31T23:59:59Z`.
- During the rollback window, operators can force Python runtime with:
  - `MUADDIB_RUNTIME=python`
  - verify resolved override before restart: `MUADDIB_RUNTIME=python docker compose config | rg MUADDIB_RUNTIME`

## Preflight checklist

1. **Build artifacts available**
   - `cd ts && npm ci && npm run build`
2. **Config contract sanity**
   - no deferred keys in TS runtime: `chronicler`, `chronicler.quests`, `quests`, `rooms.*.proactive`
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
6. Expand to full deployment.

## Success criteria

- No startup contract failures in production config.
- No sustained send failures after bounded retries.
- Message edit updates and thread/reply behavior validated on live Discord/Slack channels.
- No rollback required through the window.
