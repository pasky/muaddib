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
