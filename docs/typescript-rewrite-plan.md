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

### Remaining gaps (post-finalization)
1. Implement actual OAuth/session-backed token refresh plumbing for non-static provider credentials (TS currently enforces static `providers.*.key` or env-var fallback only).
2. Full production Slack/Discord operational hardening (retry policies, rate limits, richer identity resolution, message edit/thread nuances).
3. Packaging/distribution cutover work to make TS service the default shipped runtime (Python entrypoint deprecation choreography).

### Compatibility notes (intentional Python vs TS divergences)
- TS runtime currently **fails fast** if deferred Python-only config keys are present, instead of silently ignoring them.
  - rejected keys: `chronicler`, `chronicler.quests`, `quests`, and `rooms.*.proactive`
- TS runtime also **fails fast** on unsupported non-static provider credential config, instead of silently falling through:
  - rejected credential keys: `providers.*.key` (non-string values), `providers.*.oauth`, `providers.*.session`
  - supported TS contract today: static `providers.*.key` string or provider SDK env-var fallback
- Python supports proactive interjections and chronicler/quests automation; TS parity target v1 intentionally does not.
- TS still keeps storage-layer primitives (history + chronicle DB semantics) for migration continuity, but runtime automation for chronicling/proactive/quests remains deferred.

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
