# TypeScript Runtime Deployment + Rollback Runbook

## Objective

Run muaddib service on the TypeScript runtime by default, with explicit rollback path to Python until `2026-03-31T23:59:59Z`.

## Deploy (TS default)

### Docker Compose

1. Ensure env:
   - `MUADDIB_RUNTIME=ts`
   - `MUADDIB_TS_ROLLBACK_UNTIL=2026-03-31T23:59:59Z`
2. Rebuild and restart:
   - `docker compose build muaddib`
   - `docker compose up -d muaddib`
3. Verify startup logs include:
   - `Runtime=ts service mode`

### Non-compose/systemd style

Use TS runtime entrypoint command:

```bash
cd /path/to/repo/ts
npm ci
npm run build
npm run start -- --config /path/to/config.json
```

## Operational checks after deploy

1. Bot connects to enabled rooms.
2. Direct mention replies succeed on Discord/Slack.
3. Slack/Discord edits update chat history records.
4. No repeated bounded-retry exhaustion on outbound send paths.

## Rollback triggers

Rollback to Python runtime if any of the following persist and cannot be mitigated quickly:

- sustained transport send failures
- parity regression in message routing, thread handling, or history persistence
- repeated startup contract failures from production config that block service start

## Rollback procedure

### Docker Compose rollback

1. Set runtime override:
   - `MUADDIB_RUNTIME=python`
2. Restart service:
   - `docker compose up -d muaddib`
3. Verify log line:
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
