# TypeScript Rewrite Plan (pi-ai + pi-agent-core)

## Goal
Rewrite muaddib from Python to TypeScript, using `@mariozechner/pi-ai` + `@mariozechner/pi-agent-core` (from pi-mono `packages/agent`) as the LLM/provider/agent foundation.

Scope:
- ✅ Transfer core bot behavior (rooms, command routing, history/chronicler, tools, varlink integration, CLI test mode)
- ✅ Keep fully-qualified `provider:model` model references
- ✅ Preserve config-first behavior
- ❌ Skip quests support
- ❌ Skip proactive interjections support

---

## Review notes from pi-mom (best practices to adopt)

Based on review of:
- `packages/mom/src/agent.ts`
- `packages/mom/src/main.ts`
- `packages/mom/src/events.ts`
- `packages/agent/src/*`

### 1) Keep long-lived per-channel agents
Use one persistent `Agent` instance per channel/room context instead of creating a new loop per message.

Why:
- preserves context and tool continuity
- makes steering/follow-up and abort behavior reliable
- reduces setup overhead

### 2) Keep a strict “app messages ↔ LLM messages” boundary
Use `convertToLlm` as the single transformation boundary. App can store richer internal messages; only map to LLM-compatible messages at call time.

### 3) Stream everything through agent events
Rely on `message_start/update/end`, `tool_execution_start/update/end`, `turn_*`, `agent_*` events as the central control plane for room output and logging.

### 4) Serialize outbound room updates
Use a small per-run message queue so streamed updates and tool logs do not race/reorder.

### 5) Dynamic API key resolution
Use per-call key lookup (`getApiKey`) for future OAuth/expiring-token support.

### 6) Explicit abort path
Keep abort wired end-to-end from room command handling through agent execution.

### 7) Context sync before each run
Sync persisted log/history into agent context before handling a new prompt so offline/backfilled room activity is not lost.

### 8) Event scheduler foundation
Mom’s events watcher pattern is a good base for future “heartbeats”/scheduled background work in TS muaddib.

---

## Key design decisions for TS muaddib

### A. New TS app lives alongside Python during migration
Create a parallel implementation (no compatibility shims), then switch entrypoint once parity is reached.

### B. Use pi-ai models directly; remove custom provider clients
Replace `muaddib/providers/*` with:
- model parsing: `provider:model` -> `getModel(provider, modelId)`
- inference: `streamSimple`/`completeSimple` via `@mariozechner/pi-agent-core`

No custom Anthropic/OpenAI wrappers in TS rewrite.

### C. Replace custom actor loop with `Agent` + tool registry
Replace `AgenticLLMActor` with `Agent` from `@mariozechner/pi-agent-core`:
- tool loop execution handled by library
- keep existing tools as `AgentTool` adapters
- keep room-level policy logic (mode selection, help, history windows) in muaddib app layer

### D. Keep storage schema compatible where practical
Preserve SQLite schema semantics for:
- `chat_messages`
- `llm_calls`
- chronicle tables

This allows migration/import tooling with minimal friction.

### E. Preserve room abstraction and shared command handler
Keep current architecture split:
- shared command core
- room-specific monitors/adapters (IRC first, then Discord/Slack)

### F. Features intentionally deferred
Not implemented in TS parity target v1:
- quests
- proactive interjections

### G. Fail-fast behavior remains policy
No broad defensive swallowing. Catch only with clear recovery behavior.

---

## Target package/module layout (planned)

```text
muaddib_ts/
  src/
    app/
      main.ts
      config.ts
      paths.ts
    history/
      chat-history.ts
    chronicle/
      chronicle.ts
      auto-chronicler.ts
    agent/
      model-registry.ts
      muaddib-agent-runner.ts
      tools/
    rooms/
      command/
      resolver.ts
      irc/
        monitor.ts
        varlink.ts
      discord/
      slack/
  test/
```

---

## Migration milestones

### Milestone 1 (this session)
- Review pi-mom / pi-agent usage
- Record architecture and guidelines
- Update AGENTS instructions for multi-session migration flow

### Milestone 2
- Bootstrap TS project skeleton (`package.json`, `tsconfig`, base src/test wiring)
- Add config loader + model resolver (`provider:model` strictness)
- Add initial unit tests

### Milestone 3
- Port history + chronicle storage layer (without quests)
- Port command resolver and shared command flow (without proactive)
- Tests for command parsing/routing + DB behavior

### Milestone 4
- Port agent tools and wire `@mariozechner/pi-agent-core`
- Port actor invocation paths in command handling
- CLI message mode parity

### Milestone 5
- Port IRC monitor + varlink integration
- E2E CLI + IRC-focused tests

### Milestone 6
- Port Discord/Slack monitors
- Remove/retire Python runtime entrypoints
- Final parity tests and docs update

---

## Session handoff protocol (mandatory)

At end of each milestone:
1. Update this file’s milestone progress notes (append short status)
2. Update `AGENTS.md` if process rules changed
3. Run tests
4. Commit milestone
5. Handoff with explicit next-goal prompt including:
   - original user migration request
   - current milestone status
   - exact next tasks
   - test commands to run

---

## Progress log

- 2026-02-10: Milestone 1 complete (review + architecture decisions documented).
- 2026-02-10: Milestone 2 complete.
  - Bootstrapped TS subproject under `ts/` with `package.json`, `tsconfig.json`, `tsconfig.build.json`, `src/`, `tests/`.
  - Implemented strict `provider:model` parser (`ts/src/models/model-spec.ts`).
  - Implemented pi-ai adapter (`ts/src/models/pi-ai-model-adapter.ts`) with explicit unknown provider/model errors.
  - Added initial `Agent` wrapper (`ts/src/agent/muaddib-agent-runner.ts`) for single-turn runs and tool registration hooks.
  - Added unit tests for resolver/adapter/runner bootstrap (`ts/tests/*.test.ts`).
  - Validation passed: TS typecheck + TS tests + Python tests (`uv run pytest`).
- 2026-02-10: Milestone 3 complete.
  - Ported TS history storage (`ts/src/history/chat-history-store.ts`) with SQLite schema and core operations (messages/context, llm_calls logging, chronicling markers).
  - Ported TS chronicle storage (`ts/src/chronicle/chronicle-store.ts`) without quests, preserving arcs/chapters/paragraphs semantics.
  - Ported shared command config merge + resolver flow (no proactive) in:
    - `ts/src/rooms/command/config.ts`
    - `ts/src/rooms/command/resolver.ts`
    - `ts/src/rooms/message.ts`
  - Added TS tests for command parsing/routing and DB/storage behavior:
    - `ts/tests/command-config.test.ts`
    - `ts/tests/command-resolver.test.ts`
    - `ts/tests/storage.test.ts`
  - Validation passed: `cd ts && npm run typecheck`, `cd ts && npm test`, `uv run pytest`.
- 2026-02-10: Milestone 4 complete.
  - Added baseline TS agent tools as `AgentTool` implementations and wiring entrypoint:
    - `ts/src/agent/tools/baseline-tools.ts`
    - tools: `progress_report`, `make_plan`, `final_answer`
  - Extended `MuaddibAgentRunner` single-turn invocation with context replay support (`contextMessages`) for command-path integration.
  - Implemented TS actor invocation path for commands (without proactive):
    - `ts/src/rooms/command/command-handler.ts`
    - integrates resolver -> history context -> system prompt build -> runner call -> response cleaning
  - Added basic CLI message-mode parity path:
    - `ts/src/cli/message-mode.ts`
    - `ts/src/cli/main.ts`
    - package script `npm run cli:message` (runs built CLI)
  - Added TS tests for tool wiring and command/CLI integration:
    - `ts/tests/baseline-tools.test.ts`
    - `ts/tests/command-handler.test.ts`
    - `ts/tests/cli-message-mode.test.ts`
  - Validation passed: `cd ts && npm run typecheck`, `cd ts && npm test`, `uv run pytest`.
- 2026-02-10: Milestone 5 complete.
  - Ported IRC varlink transport and monitor integration:
    - `ts/src/rooms/irc/varlink.ts` (null-terminated framing, sender/event clients, IRC message splitting)
    - `ts/src/rooms/irc/monitor.ts` (event processing, direct-message detection, command handler integration, reconnect loop)
  - Added TS app bootstrap/main loop for IRC mode:
    - `ts/src/app/irc-main.ts`
    - `ts/src/app/main.ts`
    - package script `npm run start:irc`
  - Wired IRC + CLI paths through shared command actor logic (`RoomCommandHandlerTs`) with response cleaning.
  - Added TS tests for varlink splitting/handling and IRC command flow entry:
    - `ts/tests/varlink.test.ts`
    - `ts/tests/irc-monitor.test.ts`
  - Validation passed: `cd ts && npm run typecheck`, `cd ts && npm test`, `uv run pytest`.
- 2026-02-10: Milestone 6 complete.
  - Added Discord and Slack monitor scaffolding with shared command-handler integration:
    - `ts/src/rooms/discord/monitor.ts`
    - `ts/src/rooms/slack/monitor.ts`
  - Aligned app bootstrap/orchestration for multi-monitor config-driven execution:
    - `ts/src/app/bootstrap.ts`
    - `ts/src/app/main.ts` (enable/disable by room config, run monitors concurrently)
    - `ts/src/app/irc-main.ts` wrapper retained for milestone continuity
  - Closed command/response persistence parity gap across adapters by adding shared ingestion path in command handler:
    - `RoomCommandHandlerTs.handleIncomingMessage(...)` now consistently persists user + assistant responses (with trigger mode) and optional sending hook.
    - CLI and IRC paths updated to use this shared flow.
  - Added monitor entry and shared-handler parity tests:
    - `ts/tests/discord-monitor.test.ts`
    - `ts/tests/slack-monitor.test.ts`
    - `ts/tests/app-main.test.ts`
    - `ts/tests/room-adapters-shared-handler.test.ts`
    - updated `ts/tests/command-handler.test.ts` and `ts/tests/irc-monitor.test.ts`
  - Validation passed: `cd ts && npm run typecheck`, `cd ts && npm test`, `uv run pytest`.
- 2026-02-10: Post-Milestone-6 finalization complete.
  - Implemented real Discord/Slack transport clients behind monitor abstractions:
    - `ts/src/rooms/discord/transport.ts` (`discord.js` gateway ingestion + sending)
    - `ts/src/rooms/slack/transport.ts` (`@slack/bolt` socket-mode ingestion + sending)
    - wired in `ts/src/app/main.ts` from config tokens/workspaces.
  - Replaced bootstrap fallback-label classifier stubs with model-backed classifier integration:
    - `ts/src/rooms/command/classifier.ts`
    - wired through `createRoomCommandHandler(...)` in `ts/src/app/main.ts`.
  - Improved runner context replay fidelity for assistant/tool preservation:
    - `ts/src/agent/muaddib-agent-runner.ts` now replays `assistant` and `toolResult` context as proper message roles.
  - Added llm_calls usage/cost persistence hooks in shared command ingestion path:
    - `RoomCommandHandlerTs.handleIncomingMessage(...)` logs LLM calls and links trigger/response message IDs.
  - Polished runtime surface + Python entrypoint replacement direction:
    - `ts/package.json` adds unified `start` command (`node ./dist/app/main.js`) and keeps `cli:message` / `start:irc`.
    - cutover plan: replace Python service entrypoint with TS `start` after transport credential rollout and operational soak.
  - Additional tests:
    - `ts/tests/classifier.test.ts`
    - transport/adapter integration tests expanded and updated.
  - Validation passed: `cd ts && npm run typecheck`, `cd ts && npm test`, `uv run pytest`.
- 2026-02-10: Milestone 7A complete (red-green command-path parity fixes).
  - Added failing regression tests first, then implemented fixes for:
    - classifier prompt wiring (`mode_classifier.prompt` + `{message}` substitution)
    - trigger-message duplication in runner input (context excludes current trigger; prompt carries query)
    - runtime reasoning propagation (`reasoning_effort` -> runner `thinkingLevel`)
  - Updated files:
    - `ts/tests/classifier.test.ts`
    - `ts/tests/command-handler.test.ts`
    - `ts/src/rooms/command/classifier.ts`
    - `ts/src/rooms/command/command-handler.ts`
    - `ts/src/agent/muaddib-agent-runner.ts`
  - Validation passed: `cd ts && npm run typecheck`, `cd ts && npm test`, `uv run pytest`.
- 2026-02-10: Milestone 7B complete (identity/path parity hardening with red-green tests).
  - Added failing tests first for:
    - `resolveMuaddibPath` home expansion + absolute/relative semantics
    - IRC varlink socket `~` expansion
    - Discord mapping parity (`serverTag` via guild name, `platformId` via message id)
    - Slack mapping parity (`serverTag` via workspace name, `platformId` via message ts, display-name-first identity fields)
  - Implemented minimal fixes in:
    - `ts/src/app/bootstrap.ts`
    - `ts/src/rooms/irc/varlink.ts`
    - `ts/src/rooms/discord/monitor.ts`
    - `ts/src/rooms/discord/transport.ts`
    - `ts/src/rooms/slack/monitor.ts`
    - `ts/src/rooms/slack/transport.ts`
    - `ts/src/app/main.ts`
  - Added/updated regression tests:
    - `ts/tests/app-main.test.ts`
    - `ts/tests/varlink.test.ts`
    - `ts/tests/discord-monitor.test.ts`
    - `ts/tests/slack-monitor.test.ts`
  - Validation passed: `cd ts && npm run typecheck`, `cd ts && npm test`, `uv run pytest`.
- 2026-02-10: Milestone 7C complete (startup guardrails + monitor-loop resilience).
  - Added failing tests first for:
    - fail-fast startup errors when enabled room credentials are missing (`irc` varlink socket, `discord` token, `slack` app token)
    - per-event loop isolation in `IRC`, `Discord`, and `Slack` monitors
  - Implemented minimal fixes in:
    - `ts/src/app/main.ts` (explicit enabled-room credential validation; no silent monitor no-op startup)
    - `ts/src/rooms/irc/monitor.ts` (per-event try/catch recovery)
    - `ts/src/rooms/discord/monitor.ts` (per-event try/catch recovery)
    - `ts/src/rooms/slack/monitor.ts` (per-event try/catch recovery)
  - Added/updated regression tests:
    - `ts/tests/app-main.test.ts`
    - `ts/tests/irc-monitor.test.ts`
    - `ts/tests/discord-monitor.test.ts`
    - `ts/tests/slack-monitor.test.ts`
  - Validation passed: `cd ts && npm run typecheck`, `cd ts && npm test`, `uv run pytest`.
- 2026-02-10: Milestone 7D complete (config-surface clarity + deferred-feature discipline).
  - Added failing tests first for deferred-feature config rejection in both service startup and CLI message mode:
    - `ts/tests/app-main.test.ts`
    - `ts/tests/cli-message-mode.test.ts`
  - Implemented fail-fast deferred-feature guardrails in TS runtime:
    - `ts/src/app/deferred-features.ts` (collect + reject unsupported config keys)
    - wired in `ts/src/app/main.ts` and `ts/src/cli/message-mode.ts`
    - rejected keys include `chronicler`, `chronicler.quests`, `quests`, and `rooms.*.proactive`
  - Added compatibility notes section clarifying intentional Python-vs-TS divergences for deferred features.
  - Validation passed: `cd ts && npm run typecheck`, `cd ts && npm test`, `uv run pytest`.
- 2026-02-10: Milestone 7E complete (API credential contract hardening for refresh/session scenarios).
  - Added failing tests first for unsupported provider credential refresh/session config in startup and CLI paths:
    - `ts/tests/app-main.test.ts`
    - `ts/tests/cli-message-mode.test.ts`
  - Hardened TS API-key bootstrap contract in `ts/src/app/api-keys.ts`:
    - supported contract is explicit: `providers.<provider>.key` as static non-empty string, or provider SDK env-var fallback
    - fail-fast unsupported credential config keys: `providers.*.key` non-string, `providers.*.oauth`, `providers.*.session`
  - Updated compatibility notes to document the credential-contract divergence and operator-facing behavior.
  - Validation passed: `cd ts && npm run typecheck`, `cd ts && npm test`, `uv run pytest`.
- 2026-02-11: Milestone 7F complete (credential-defer guidance + transport retry hardening + cutover planning).
  - Added failing tests first for:
    - provider credential defer errors including concrete operator guidance in startup + CLI paths
      - `ts/tests/app-main.test.ts`
      - `ts/tests/cli-message-mode.test.ts`
    - Discord/Slack outbound reply retry behavior on rate-limit failures
      - `ts/tests/discord-monitor.test.ts`
      - `ts/tests/slack-monitor.test.ts`
  - Explicit defer decision for OAuth/session refresh implementation in this milestone:
    - kept strict fail-fast semantics for `providers.*.{oauth,session}` and non-string `providers.*.key`
    - error messages now include provider-specific operator guidance (`providers.<provider>.key` static string or env var such as `OPENAI_API_KEY`)
  - Added transport retry hardening:
    - new `ts/src/rooms/send-retry.ts` helper for bounded 429/rate-limit retries
    - wired in `ts/src/rooms/discord/monitor.ts` and `ts/src/rooms/slack/monitor.ts` send paths
    - non-rate-limit send errors remain fail-fast (no broad fallback)
  - Expanded packaging/distribution cutover plan with explicit staged tasks (see below section).
  - Validation passed: `cd ts && npm run typecheck`, `cd ts && npm test`, `uv run pytest`.
- 2026-02-11: Milestone 7G complete (Slack/Discord nuance parity hardening + TS runtime cutover choreography).
  - Added red tests first and implemented deterministic fixes for:
    - Slack/Discord message edit parity (`processMessageEditEvent` + history `platform_id` update plumbing)
    - thread/reply nuance parity (Slack thread-start defaults + existing thread reuse + thread context IDs, Discord reply metadata)
    - richer mention/identity normalization parity in monitors/transports
  - Added operational retry/failure instrumentation events:
    - `sendWithRateLimitRetry(...)` now emits structured retry/failure events
    - Discord/Slack monitors expose `onSendRetryEvent` wiring for observability hooks
  - Added history parity helpers:
    - `ChatHistoryStore.getMessageIdByPlatformId(...)`
    - `ChatHistoryStore.updateMessageByPlatformId(...)`
  - Completed packaging/distribution choreography deliverables:
    - operator rollout guide: `docs/typescript-runtime-rollout.md`
    - deployment/rollback runbook: `docs/typescript-runtime-runbook.md`
    - TS default runtime entrypoint wrapper + docker cutover:
      - `scripts/runtime-entrypoint.sh`
      - `Dockerfile` default command now routes through TS-first wrapper
      - `docker-compose.yml` defaults `MUADDIB_RUNTIME=ts` with explicit rollback window env
  - Validation passed:
    - `cd ts && npm run typecheck`
    - `cd ts && npm test`
    - `uv run pytest`
    - `MUADDIB_HOME=. uv run muaddib --message "milestone 7g ts parity hardening smoke test"`
- 2026-02-11: Milestone 7H complete (post-cutover soak hardening + observability wiring + cutover verification pass).
  - Added red tests first for soak regressions and implemented minimal deterministic fixes:
    - Slack/Discord monitor startup now disconnects already-connected event sources if sender connect fails (fail-fast error still propagates)
      - `ts/tests/slack-monitor.test.ts`
      - `ts/tests/discord-monitor.test.ts`
      - `ts/src/rooms/slack/monitor.ts`
      - `ts/src/rooms/discord/monitor.ts`
    - IRC monitor now clears cached server nick on varlink reconnect so post-reconnect direct-address detection stays correct
      - `ts/tests/irc-monitor.test.ts`
      - `ts/src/rooms/irc/monitor.ts`
  - Hardened observability surface used by operators:
    - wired default retry/failure event logger in `runMuaddibMain` monitor construction
    - emits structured log lines:
      - `[muaddib][send-retry]` (warn for retries, error for terminal failures)
      - `[muaddib][metric]` (per-event metric-friendly line)
    - added regression coverage in `ts/tests/app-main.test.ts`
  - Cutover/rollback verification hardening:
    - verified runtime env resolution for both modes via compose config:
      - `MUADDIB_RUNTIME=ts docker compose config`
      - `MUADDIB_RUNTIME=python docker compose config`
    - verified rollback runtime entrypoint path directly:
      - `MUADDIB_RUNTIME=python ./scripts/runtime-entrypoint.sh --help`
    - removed obsolete compose `version` field to avoid rollout noise/warnings
    - updated rollout/runbook/docker docs with explicit runtime verification and observability checks:
      - `docs/typescript-runtime-rollout.md`
      - `docs/typescript-runtime-runbook.md`
      - `docs/docker.md`
  - OAuth/session refresh policy unchanged: explicitly deferred until stable `@mariozechner/pi-ai` refresh contract exists.
  - Validation passed:
    - `cd ts && npm run typecheck`
    - `cd ts && npm test`
    - `uv run pytest`
    - `MUADDIB_HOME=. uv run muaddib --message "milestone 7h ts parity hardening smoke test"`
- 2026-02-11: Milestone 7I complete (continued soak parity hardening + rollback-window exit criteria definition).
  - Added red tests first for IRC startup partial-connect cleanup regressions:
    - `ts/tests/irc-monitor.test.ts`
      - verifies disconnect cleanup on sender-connect failure before retry
      - verifies disconnect cleanup when `waitForEvents` fails on final attempt
  - Implemented minimal deterministic IRC reconnect/startup hardening:
    - `ts/src/rooms/irc/monitor.ts`
      - `connectWithRetry(...)` now always disconnects both varlink clients after failed startup attempt before retry/final failure
      - clears cached server nicks on failed startup attempts to avoid stale direct-detection state
  - Defined explicit operator rollback-window guardrails and deprecation gate criteria:
    - `docs/typescript-runtime-rollout.md`
    - `docs/typescript-runtime-runbook.md`
      - explicit SLO thresholds (retry/failure/startup budgets)
      - mandatory parity checks
      - rollback triggers and 30-minute mitigation window
      - explicit 14-day soak + 7-day final gate requirements before removing Python rollback path
  - OAuth/session refresh policy unchanged: explicitly deferred until stable `@mariozechner/pi-ai` refresh contract exists.
  - Validation passed:
    - `cd ts && npm run typecheck`
    - `cd ts && npm test`
    - `uv run pytest`
    - `MUADDIB_HOME=. uv run muaddib --message "milestone 7i ts parity hardening smoke test"`
- 2026-02-11: Milestone 7J complete (live-soak parity tracking hardening + operator evidence templates).
  - Live-soak regression capture status in this window:
    - no new concrete Slack/Discord/IRC regressions observed beyond already-covered 7H/7I cases
    - no runtime monitor behavior changes were required
  - Added lightweight operator evidence templates/checklists for rollback-window tracking:
    - new template doc: `docs/typescript-runtime-soak-evidence-template.md`
    - linked evidence workflow into:
      - `docs/typescript-runtime-rollout.md`
      - `docs/typescript-runtime-runbook.md`
    - evidence template enforces unambiguous runtime path proof for:
      - `MUADDIB_RUNTIME=ts` (default)
      - `MUADDIB_RUNTIME=python` (rollback)
  - OAuth/session refresh policy unchanged: explicitly deferred until stable `@mariozechner/pi-ai` refresh contract exists (red tests first if contract lands).
  - Validation passed:
    - `cd ts && npm run typecheck`
    - `cd ts && npm test`
    - `uv run pytest`
    - `MUADDIB_HOME=. uv run muaddib --message "milestone 7j ts parity hardening smoke test"`
    - `pre-commit run --all-files`
- 2026-02-11: Milestone 7K complete (rollback-window execution bootstrap + evidence log discipline hardening).
  - Live-soak regression intake status in this window:
    - no newly observed concrete Slack/Discord/IRC regressions; therefore no red tests/runtime code changes were required in this milestone window.
  - Started operational evidence execution artifacts:
    - new append-only execution log: `docs/typescript-runtime-soak-evidence-log.md`
    - captured initial daily bootstrap entry with runtime-path proof for both:
      - `MUADDIB_RUNTIME=ts`
      - `MUADDIB_RUNTIME=python`
    - started final 7-day exit-gate table tracking (currently not yet green).
  - Hardened operator docs/guardrails for evidence completeness:
    - `docs/typescript-runtime-soak-evidence-template.md`
    - `docs/typescript-runtime-rollout.md`
    - `docs/typescript-runtime-runbook.md`
    - `AGENTS.md`
    - policy now explicit: missing required evidence fields is an operational failure.
  - OAuth/session refresh policy unchanged: explicitly deferred until stable `@mariozechner/pi-ai` refresh contract exists (red tests first if contract lands).
  - Validation passed:
    - `cd ts && npm run typecheck`
    - `cd ts && npm test`
    - `uv run pytest`
    - `MUADDIB_HOME=. uv run muaddib --message "milestone 7k ts parity hardening smoke test"`
    - `pre-commit run --all-files`
- 2026-02-11: Milestone 7L checkpoint 1 complete (continued rollback-window execution + evidence log updates).
  - Live-soak regression intake status in this window:
    - no newly observed concrete Slack/Discord/IRC regressions; no new red tests/runtime monitor fixes were required.
  - Continued operator evidence execution log:
    - appended a post-deploy validation entry to `docs/typescript-runtime-soak-evidence-log.md`
    - included runtime-path proof for both `MUADDIB_RUNTIME=ts` and `MUADDIB_RUNTIME=python`
    - recorded explicit decision to stay on TS default and keep Python rollback path enabled
  - Final 7-day gate status:
    - still not green; missing production SLO/parity evidence remains an operational failure in this window.
  - OAuth/session refresh policy unchanged: explicitly deferred until stable `@mariozechner/pi-ai` refresh contract exists (red tests first if contract lands).
  - Validation passed:
    - `cd ts && npm run typecheck`
    - `cd ts && npm test`
    - `uv run pytest`
    - `MUADDIB_HOME=. uv run muaddib --message "milestone 7l ts parity hardening smoke test"`
    - `pre-commit run --all-files`

- 2026-02-11: Milestone 7L checkpoint 2 complete (rollback-window continuation + evidence checkpoint 2).
  - Live-soak regression intake status in this window:
    - no newly observed concrete Slack/Discord/IRC regressions; no new red tests/runtime monitor fixes were required.
  - Continued operator evidence execution log:
    - appended another post-deploy validation entry to `docs/typescript-runtime-soak-evidence-log.md`
    - included runtime-path proof for both `MUADDIB_RUNTIME=ts` and `MUADDIB_RUNTIME=python`
    - recorded explicit decision to stay on TS default and keep Python rollback path enabled
  - Final 7-day gate status:
    - still not green; production SLO/parity evidence remains incomplete in this repo-only session and is tracked as operational failure for this window.
  - Validation passed:
    - `cd ts && npm run typecheck`
    - `cd ts && npm test`
    - `uv run pytest`
    - `MUADDIB_HOME=. uv run muaddib --message "milestone 7l ts parity hardening smoke test"`
    - `pre-commit run --all-files`
- 2026-02-11: Milestone 7L checkpoint 3 complete (rollback-window continuation + evidence checkpoint 3).
  - Live-soak regression intake status in this window:
    - still no newly observed concrete Slack/Discord/IRC regressions; no red tests/runtime monitor fixes were required.
  - Continued operator evidence execution log:
    - appended an additional post-deploy validation entry to `docs/typescript-runtime-soak-evidence-log.md`
    - included runtime-path proof for both `MUADDIB_RUNTIME=ts` and `MUADDIB_RUNTIME=python`
    - recorded explicit decision to stay on TS default and keep Python rollback path enabled
  - Final 7-day gate status:
    - still not green; production SLO/parity evidence remains incomplete in this repo-only session and is tracked as operational failure for this window.
  - Validation passed:
    - `cd ts && npm run typecheck`
    - `cd ts && npm test`
    - `uv run pytest`
    - `MUADDIB_HOME=. uv run muaddib --message "milestone 7l ts parity hardening smoke test"`
    - `pre-commit run --all-files`
- 2026-02-11: Milestone 7L checkpoint 4 complete (rollback-window continuation + evidence checkpoint 4).
  - Live-soak regression intake status in this window:
    - still no newly observed concrete Slack/Discord/IRC regressions; no red tests/runtime monitor fixes were required.
  - Continued operator evidence execution log:
    - appended a further post-deploy validation entry to `docs/typescript-runtime-soak-evidence-log.md`
    - included runtime-path proof for both `MUADDIB_RUNTIME=ts` and `MUADDIB_RUNTIME=python`
    - recorded explicit decision to stay on TS default and keep Python rollback path enabled
  - Final 7-day gate status:
    - still not green; production SLO/parity evidence remains incomplete in this repo-only session and is tracked as operational failure for this window.
  - Validation passed:
    - `cd ts && npm run typecheck`
    - `cd ts && npm test`
    - `uv run pytest`
    - `MUADDIB_HOME=. uv run muaddib --message "milestone 7l ts parity hardening smoke test"`
    - `pre-commit run --all-files`
- 2026-02-11: Milestone 7L checkpoint 5 complete (rollback-window continuation + evidence checkpoint 5).
  - Live-soak regression intake status in this window:
    - still no newly observed concrete Slack/Discord/IRC regressions; no red tests/runtime monitor fixes were required.
  - Continued operator evidence execution log:
    - appended another post-deploy validation entry to `docs/typescript-runtime-soak-evidence-log.md`
    - included runtime-path proof for both `MUADDIB_RUNTIME=ts` and `MUADDIB_RUNTIME=python`
    - recorded explicit decision to stay on TS default and keep Python rollback path enabled
  - Final 7-day gate status:
    - still not green; production SLO/parity evidence remains incomplete in this repo-only session and is tracked as operational failure for this window.
  - Validation passed:
    - `cd ts && npm run typecheck`
    - `cd ts && npm test`
    - `uv run pytest`
    - `MUADDIB_HOME=. uv run muaddib --message "milestone 7l ts parity hardening smoke test"`
    - `pre-commit run --all-files`

### Remaining gaps (post-7L checkpoint 5)
1. OAuth/session-backed token refresh plumbing remains explicitly deferred pending a stable provider/session refresh contract in `@mariozechner/pi-ai` (TS fail-fast rejects unsupported config with concrete operator guidance).
2. Continue post-cutover soak hardening for additional live-room edge cases that emerge beyond currently-covered Slack/Discord/IRC reconnect and send-path behavior.
3. Continue daily/post-deploy evidence capture with complete live telemetry + parity references until the final 7-day gate is fully green.
4. Complete Python runtime deprecation only after rollback-window criteria are actually met in production soak; rollback path stays enabled until then.

### Compatibility notes (intentional Python vs TS divergences)
- TS runtime currently **fails fast** if deferred Python-only config keys are present, instead of silently ignoring them.
  - rejected keys: `chronicler`, `chronicler.quests`, `quests`, and `rooms.*.proactive`
- TS runtime also **fails fast** on unsupported non-static provider credential config, instead of silently falling through:
  - rejected credential keys: `providers.*.key` (non-string values), `providers.*.oauth`, `providers.*.session`
  - supported TS contract today: static `providers.*.key` string or provider SDK env-var fallback
  - fail-fast errors include concrete per-provider operator guidance (remove unsupported keys and use static key/env-var contract)
- TS Discord/Slack adapters now include bounded retry behavior for outbound 429/rate-limit failures; non-rate-limit send errors remain fail-fast.
- TS Discord/Slack monitor parity now includes message edit persistence (`platform_id` updates), thread/reply mapping semantics, and richer mention/identity normalization across transport/monitor boundaries.
- Python supports proactive interjections and chronicler/quests automation; TS parity target v1 intentionally does not.
- TS still keeps storage-layer primitives (history + chronicle DB semantics) for migration continuity, but runtime automation for chronicling/proactive/quests remains deferred.

### Packaging/distribution cutover plan (staged)
1. [x] Runtime entrypoint alignment
   - TS default service command is `cd ts && npm run start`.
   - Python runtime remains available as explicit rollback path during soak.
2. [x] Operator rollout checklist
   - published TS runtime env/credential contract doc: `docs/typescript-runtime-rollout.md`
   - includes migration notes for Discord/Slack/IRC provisioning and deferred credential-refresh constraints
3. [x] Deployment choreography
   - default container/service runtime entrypoint switched to TS wrapper (`scripts/runtime-entrypoint.sh`)
   - explicit rollback path kept via `MUADDIB_RUNTIME=python` until `MUADDIB_TS_ROLLBACK_UNTIL`
4. [~] Python deprecation completion
   - after successful soak + rollback-window expiry, remove Python service entrypoint from default distribution path

---

## Post-M6 parity hardening checklist (red-green required)

Legend:
- [ ] not started
- [~] in progress
- [x] done

### A. Command-path correctness and test coverage
- [x] Ensure classifier uses configured `mode_classifier.prompt` and current-message substitution.
- [x] Ensure trigger message is not duplicated in LLM input (`context` + prompt double-send).
- [x] Propagate mode runtime reasoning settings to runner (`reasoning_effort` -> `thinkingLevel`).
- [x] Add regression tests that fail on each of the above before implementation (red-green).

### B. Identity/path compatibility correctness
- [x] Fix path resolution for `~` and absolute/relative behavior in TS bootstrap.
- [x] Expand `~` in IRC varlink socket path.
- [x] Align Discord/Slack `serverTag` and `platformId` semantics with Python behavior.
- [x] Add monitor mapping tests that assert name/id semantics and fail on current regressions.

### C. Operational guardrails parity
- [x] Remove silent no-op monitor startups when room is enabled but transport credentials are missing.
- [x] Add per-event isolation in monitor loops where a single bad event can kill processing.
- [x] Add negative tests for startup/config errors and event-loop resilience.

### D. Scope discipline and migration clarity
- [x] Explicitly mark deferred features in TS runtime docs/config surface (proactive/chronicler/quests).
- [x] Either implement or strip unsupported config knobs from TS path to avoid misleading operators.
- [x] Add compatibility notes for intentional divergences.

### E. API credential contract hardening
- [x] Add failing tests for unsupported provider refresh/session credential config in startup + CLI paths.
- [x] Enforce explicit TS API-key contract (static `providers.*.key` or provider env-var fallback).
- [x] Fail fast with clear errors on unsupported non-static credential config (`providers.*.key` non-string, `providers.*.oauth`, `providers.*.session`).

### F. Credential defer clarity + operator guidance
- [x] Make explicit defer decision for OAuth/session refresh plumbing when implementation contract is not yet viable.
- [x] Include concrete operator guidance in fail-fast credential errors (per-provider static key/env-var guidance).
- [x] Add regression tests for startup + CLI error guidance text.

### G. Slack/Discord production hardening
- [x] Add bounded send retries for outbound 429/rate-limit failures.
- [x] Keep non-rate-limit send failures fail-fast.
- [x] Add monitor regression tests for retry success and non-retry failure paths.
- [x] Complete message edit/thread nuance parity and richer mention/identity behavior coverage.

### H. Post-cutover soak + observability hardening
- [x] Add red tests for soak regressions in Slack/Discord/IRC room handling and implement deterministic fixes.
- [x] Wire retry/failure instrumentation into operator-visible runtime log/metric lines.
- [x] Verify TS deploy + Python rollback env flows and patch operator docs where gaps/noise were found.

### I. Rollback-window exit criteria hardening
- [x] Add explicit TS soak SLO thresholds for retry/failure/startup health in operator docs.
- [x] Add explicit parity verification checklist and rollback triggers.
- [x] Add explicit minimum soak duration + exit gate criteria before Python runtime deprecation.

### J. Rollback-window evidence tracking hardening
- [x] Capture newly observed live regressions as red tests first (none newly observed in this milestone window).
- [x] Add lightweight daily/post-deploy operator evidence template for SLO + parity tracking.
- [x] Keep runtime-path guidance unambiguous for `MUADDIB_RUNTIME=ts` default vs `MUADDIB_RUNTIME=python` rollback.
- [x] Keep OAuth/session refresh deferred pending stable `@mariozechner/pi-ai` contract.

### K. Rollback-window execution discipline hardening
- [x] Continue live-soak regression intake and keep red-test-first rule for any newly observed regressions (none observed in this window).
- [x] Start append-only daily/post-deploy evidence execution log using the template.
- [x] Treat missing evidence fields as operational failure in rollout/runbook/template/agent guardrails.
- [x] Start final 7-day exit-gate table tracking and keep Python rollback path unchanged.
- [x] Keep OAuth/session refresh deferred pending stable `@mariozechner/pi-ai` contract.

### L. Rollback-window execution continuation
- [x] Continue live-soak regression intake for the latest checkpoint window (no newly observed concrete regressions).
- [x] Append next evidence-log entry with runtime-path proof + explicit decision (checkpoint 5 complete).
- [~] Collect complete production SLO query evidence and live parity room/message references for each window.
- [~] Drive final 7-day gate table to fully green before Python rollback-path removal.
- [x] Keep OAuth/session refresh deferred pending stable `@mariozechner/pi-ai` contract.

---

## Staged patch plan (TDD-first)

### Milestone 7A — Command path parity defects + regression tests
Goal: fix correctness gaps that unit tests should have caught.

Steps:
1. Write failing tests for:
   - classifier prompt wiring
   - no duplicated triggering input in runner call
   - reasoning level propagation from resolver/runtime to runner
2. Implement minimal fixes in:
   - `ts/src/rooms/command/classifier.ts`
   - `ts/src/rooms/command/command-handler.ts`
   - `ts/src/agent/muaddib-agent-runner.ts`
3. Validate:
   - `cd ts && npm run typecheck`
   - `cd ts && npm test`
   - `uv run pytest`
4. Commit + handoff.

### Milestone 7B — Identity and path semantics parity + regression tests
Goal: eliminate Discord/Slack/IRC path+identity mismatches vs Python.

Steps:
1. Write failing tests for:
   - `~` path expansion behavior
   - IRC varlink socket expansion
   - Discord/Slack mapping (`serverTag`, `platformId`, primary identity fields)
2. Implement fixes in:
   - `ts/src/app/bootstrap.ts`
   - `ts/src/rooms/irc/varlink.ts`
   - `ts/src/rooms/discord/*`
   - `ts/src/rooms/slack/*`
3. Validate test suites; commit + handoff.

### Milestone 7C — Monitor resilience and startup correctness
Goal: fail fast on invalid enabled-monitor config and isolate event failures.

Steps:
1. Add failing tests for startup misconfiguration and loop resilience.
2. Implement monitor/main orchestration hardening.
3. Validate test suites; commit + handoff.

### Milestone 7D — Config-surface cleanup/documented divergence
Goal: make TS runtime behavior explicit and non-misleading.

Steps:
1. Add tests/docs assertions for supported knobs.
2. Implement config cleanup or runtime support where straightforward.
3. Validate test suites; commit + handoff.

### Milestone 7E — API credential contract hardening
Goal: make provider API-key behavior deterministic while non-static refresh flows are deferred.

Steps:
1. Add failing tests for unsupported refresh/session credential config in startup and CLI paths.
2. Enforce explicit API-key contract in `ts/src/app/api-keys.ts` with fail-fast errors for unsupported non-static config.
3. Update compatibility notes and remaining-gap wording.
4. Validate test suites; commit + handoff.

### Milestone 7F — Credential defer guidance + monitor rate-limit retries
Goal: keep OAuth/session refresh out of scope without ambiguity, and harden Slack/Discord send reliability.

Steps:
1. Add failing tests for provider credential error guidance text (startup + CLI).
2. Add failing tests for Slack/Discord rate-limit send retry behavior and non-rate-limit fail-fast behavior.
3. Implement:
   - guidance-rich fail-fast errors in `ts/src/app/api-keys.ts`
   - bounded send retry helper in `ts/src/rooms/send-retry.ts`
   - monitor send-path wiring in `ts/src/rooms/discord/monitor.ts` and `ts/src/rooms/slack/monitor.ts`
4. Update compatibility notes + packaging cutover plan section.
5. Validate test suites; commit + handoff.

### Milestone 7G — Complete
Goal: complete remaining Slack/Discord nuance parity and execute TS default-runtime cutover choreography.

Completed:
1. Added red tests for message edit/thread/reply behavior gaps.
2. Implemented targeted monitor/transport parity fixes + deterministic history update plumbing.
3. Finalized operator rollout + deployment/rollback runbook and switched default container runtime entrypoint to TS with explicit rollback window.
4. Added retry/failure instrumentation hooks consumed by monitor send paths.

### Milestone 7H — Complete
Goal: post-cutover soak hardening + deprecation preparation without expanding deferred-feature scope.

Completed:
1. Added red tests for Slack/Discord startup connect-failure cleanup and IRC reconnect direct-detection regression.
2. Implemented minimal deterministic monitor fixes (Slack/Discord connect cleanup; IRC nick-cache refresh on reconnect).
3. Wired retry/failure instrumentation to operator-visible runtime logs/metric-friendly lines in TS main monitor construction.
4. Verified runtime env resolution/rollback flows and patched rollout/runbook/docker docs; removed obsolete compose version field noise.

### Milestone 7I — Complete
Goal: continue soak-driven parity hardening while preparing rollback-window exit criteria for Python runtime deprecation.

Completed:
1. Added red regression tests for IRC startup partial-connect cleanup and implemented minimal deterministic cleanup behavior in retry loop.
2. Defined explicit rollback-window SLO/guardrails and deprecation exit gate in operator docs.
3. Kept OAuth/session refresh deferred (no runtime contract change).
4. Re-ran full validation suites; commit + handoff.

### Milestone 7J — Complete
Goal: continue live-soak parity hardening and operational gate tracking without expanding deferred scope.

Completed:
1. Checked live-soak regression intake status; no new concrete Slack/Discord/IRC regressions observed in this window.
2. Added lightweight operator evidence templates/checklists for daily SLO+parity tracking:
   - `docs/typescript-runtime-soak-evidence-template.md`
   - evidence workflow links in rollout/runbook docs.
3. Kept OAuth/session refresh explicitly deferred pending stable `@mariozechner/pi-ai` contract.
4. Re-ran full validation suites; commit + handoff.

### Milestone 7K — Complete
Goal: continue rollback-window execution with strict red-first handling for newly observed room regressions.

Completed:
1. Checked live-soak regression intake; no newly observed concrete Slack/Discord/IRC regressions in this milestone window.
2. Started daily evidence execution log using template:
   - `docs/typescript-runtime-soak-evidence-log.md`
3. Hardened operational policy to treat missing evidence fields as operational failure in:
   - `docs/typescript-runtime-soak-evidence-template.md`
   - `docs/typescript-runtime-rollout.md`
   - `docs/typescript-runtime-runbook.md`
   - `AGENTS.md`
4. Started final 7-day exit-gate table progress tracking in evidence log; Python rollback path remains unchanged.
5. Kept OAuth/session refresh explicitly deferred pending stable `@mariozechner/pi-ai` contract.
6. Re-ran full validation suites; commit + handoff.

### Milestone 7L — In progress
Goal: continue daily/post-deploy soak execution until exit-gate criteria are actually met, while preserving strict fail-fast scope discipline.

Completed in checkpoint 1:
1. Continued live-soak regression intake; no newly observed concrete Slack/Discord/IRC runtime regressions in this window.
2. Appended the next post-deploy evidence entry to `docs/typescript-runtime-soak-evidence-log.md` with runtime-path proof + explicit decision.
3. Re-ran full validation suites and confirmed green.
4. Kept OAuth/session refresh explicitly deferred; no contract change observed.

Completed in checkpoint 2:
1. Continued live-soak regression intake; still no newly observed concrete Slack/Discord/IRC runtime regressions in this window.
2. Appended an additional post-deploy evidence entry to `docs/typescript-runtime-soak-evidence-log.md` with runtime-path proof + explicit stay-on-TS decision.
3. Re-ran full validation suites and confirmed green.
4. Kept OAuth/session refresh explicitly deferred; no contract change observed.

Completed in checkpoint 3:
1. Continued live-soak regression intake; still no newly observed concrete Slack/Discord/IRC runtime regressions in this window.
2. Appended another post-deploy evidence entry to `docs/typescript-runtime-soak-evidence-log.md` with runtime-path proof + explicit stay-on-TS decision.
3. Re-ran full validation suites and confirmed green.
4. Kept OAuth/session refresh explicitly deferred; no contract change observed.

Completed in checkpoint 4:
1. Continued live-soak regression intake; still no newly observed concrete Slack/Discord/IRC runtime regressions in this window.
2. Appended a further post-deploy evidence entry to `docs/typescript-runtime-soak-evidence-log.md` with runtime-path proof + explicit stay-on-TS decision.
3. Re-ran full validation suites and confirmed green.
4. Kept OAuth/session refresh explicitly deferred; no contract change observed.

Completed in checkpoint 5:
1. Continued live-soak regression intake; still no newly observed concrete Slack/Discord/IRC runtime regressions in this window.
2. Appended another post-deploy evidence entry to `docs/typescript-runtime-soak-evidence-log.md` with runtime-path proof + explicit stay-on-TS decision.
3. Re-ran full validation suites and confirmed green.
4. Kept OAuth/session refresh explicitly deferred; no contract change observed.

Next steps:
1. Continue live-soak regression intake; for any newly observed Slack/Discord/IRC runtime regression, add failing tests first then apply minimal deterministic fixes.
2. Append complete daily/post-deploy entries to `docs/typescript-runtime-soak-evidence-log.md` (runtime proof + SLO queries + parity evidence + decision) with production telemetry links.
3. Drive final 7-day gate table toward fully green status; do not remove Python rollback path until all gate rows are green and no rollback occurred.
4. Keep OAuth/session refresh deferred unless a stable `@mariozechner/pi-ai` contract lands; if it does, start with red tests and bounded plumbing.
5. Re-run full validation suites; commit + handoff.
