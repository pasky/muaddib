# TypeScript Rewrite Plan (pi-ai + pi-agent-core)

## Purpose
Keep a compact, up-to-date plan for the TypeScript runtime rewrite, focused on:
- stable design decisions,
- implemented functionality,
- important Python vs TS behavioral differences,
- remaining parity gaps.

Historical milestone-by-milestone notes were intentionally removed; use git history for full chronology.

Latest update:
- 2026-02-13: Added TS DeepSeek provider parity bridge for Anthropic-compatible `deepseek:*` model specs across command/classifier/context-reducer/chronicler paths by extending `PiAiModelAdapter` + shared adapter wiring in app/CLI startup, with regression coverage in `ts/tests/pi-ai-model-adapter.test.ts` and `ts/tests/cli-message-mode.test.ts`.
- 2026-02-13: Closed TS response-cleaning parity gap for echoed IRC prefixes (strip leading `[model]` / `!mode` / `[HH:MM]` / non-quest `<nick>` wrappers while preserving `<quest>` and `<quest_finished>` payloads) in `RoomCommandHandlerTs`, with regression coverage in `ts/tests/command-handler.test.ts`.
- 2026-02-13: Improved TS per-message command observability by wiring runtime logger into `RoomCommandHandlerTs` and emitting direct-command lifecycle entries (handle/resolution/persist), ensuring message-sharded logs contain more than monitor-only lines.
- 2026-02-12: Switched TS parity-fix stream validation to TS-only (`cd ts && npm run typecheck && npm test`) and started closing parity-audit backlog incrementally.
- 2026-02-12: Added `docs/typescript-parity-audit.md` with a code-referenced Python-vs-TS matrix, severity-ranked gaps, architecture risks, and remediation plan.
- 2026-02-12: Closed TS command debounce/followup merge parity gap (`command.debounce` + thread-aware followup coalescing in command path).
- 2026-02-12: Closed TS steering/session queue compaction parity gap (`steering-queue.ts` + queued command/session integration in `RoomCommandHandlerTs` + queue scenario tests).
- 2026-02-12: Closed agent-loop/tooling core parity gap in TS:
  - `MuaddibAgentRunner` now enforces iterative loop semantics with iteration cap and non-empty completion retries.
  - Baseline tools now include `web_search`, `visit_webpage`, `execute_code` plus existing progress/plan/final tools.
  - Added loop/tool regression coverage in `ts/tests/muaddib-agent-runner.test.ts` and `ts/tests/baseline-tools.test.ts`.
- 2026-02-12: Closed advanced artifact tool parity step 2:
  - Baseline/executor support added for `share_artifact` and `edit_artifact` (`ts/src/agent/tools/baseline-tools.ts`, `ts/src/agent/tools/core-executors.ts`).
  - Artifact tool wiring now reads `tools.artifacts.path`/`tools.artifacts.url` with MUADDIB_HOME-relative path resolution in app + CLI command paths (`ts/src/app/main.ts`, `ts/src/cli/message-mode.ts`).
  - Added artifact tool wiring tests and focused executor coverage (`ts/tests/baseline-tools.test.ts`, `ts/tests/core-executors.test.ts`).
- 2026-02-12: Closed advanced tool parity step 3:
  - Baseline/executor support added for `oracle` and `generate_image` (`ts/src/agent/tools/baseline-tools.ts`, `ts/src/agent/tools/core-executors.ts`).
  - Executor config wiring now reads `tools.oracle.*`, `tools.image_gen.model`, and OpenRouter base URL + API-key resolution in app + CLI command paths (`ts/src/app/main.ts`, `ts/src/cli/message-mode.ts`).
  - Added baseline wiring + focused oracle/image executor coverage (`ts/tests/baseline-tools.test.ts`, `ts/tests/core-executors.test.ts`).
- 2026-02-12: Closed refusal-fallback parity slice in TS command path:
  - Added deterministic refusal/error trigger policy and fallback rerun behavior using `router.refusal_fallback_model`.
  - Added fail-fast config validation for malformed/unsupported fallback model specs (`provider:model` required, unknown provider/model rejected).
  - Added command-handler + CLI tests covering fallback activation/non-activation and fallback persistence/logging assertions.
- 2026-02-12: Closed persistence-summary callback parity slice in TS command/runner path:
  - Added runner-side persistent tool-call collection + summary generation via `tools.summary.model`, with callback invocation and error logging containment.
  - Added command-path persistence semantics for callback output as `[internal monologue] {message}` assistant history rows.
  - Added fail-fast validation for malformed/unsupported `tools.summary.model` in app + CLI paths.
  - Added/extended tests for callback invocation/non-invocation, error paths, and callback persistence assertions.
- 2026-02-12: Closed chronicler/quest tool-surface parity slice in TS baseline/executor path:
  - Baseline tools now include `chronicle_read`, `chronicle_append`, `quest_start`, `subquest_start`, `quest_snooze` (`ts/src/agent/tools/baseline-tools.ts`).
  - Added executor wiring for chronicler/quest tools (`ts/src/agent/tools/core-executors.ts`) and per-message arc injection in command-path tool creation (`ts/src/rooms/command/command-handler.ts`).
  - Extended `ChronicleStore` with relative chapter rendering used by `chronicle_read` (`ts/src/chronicle/chronicle-store.ts`).
  - Preserved deferred-runtime guardrails: quest executors return explicit deferred-runtime rejection guidance in parity v1.
  - Added/extended tests for baseline tool wiring, executor behavior, command allowed-tools filtering, runner persistence-summary behavior, and chronicle relative rendering (`ts/tests/baseline-tools.test.ts`, `ts/tests/core-executors.test.ts`, `ts/tests/command-handler.test.ts`, `ts/tests/muaddib-agent-runner.test.ts`, `ts/tests/storage.test.ts`).
- 2026-02-12: Closed `response_max_bytes` parity + landed first transport P1 tranche:
  - `RoomCommandHandlerTs` now enforces `command.response_max_bytes` with Python-aligned long-response artifact fallback (`... full response: <artifact-url>`), including fail-fast validation for invalid values.
  - Added app/CLI-path validation coverage and command-path tests for long-response trigger/non-trigger behavior, persistence semantics, and fallback-model LLM linkage when artifact fallback is active.
  - Added Discord/Slack attachment context parity in monitors/transports and Slack private-file secrets propagation into room messages/tool fetches.
  - Added configurable Discord/Slack reconnect supervision for receive-loop failures (transport disconnect signals + monitor reconnect tests).
- 2026-02-12: Closed transport UX + reconnect-boundary parity slice and command-path context reducer parity:
  - Discord monitor/transport now support reply-edit debounce behavior (rapid followups merged by editing prior bot reply in-window).
  - Slack monitor/transport now support reply-edit debounce (`chat.update`), outgoing mention formatting (`@DisplayName` -> `<@USER_ID>` where cached), and typing-indicator lifecycle (`assistant.threads.setStatus` set/refresh/clear).
  - Discord/Slack reconnect policy is now explicit and tested: receive-loop errors trigger supervised reconnect (when enabled), while `null` events are graceful shutdown signals (no reconnect).
  - Added reconnect boundary tests for null shutdown, reconnect disabled/enabled, and max-attempts exhaustion in both Discord and Slack monitor suites.
  - Added shared command-path context reducer support (`context_reducer` root config + mode `auto_reduce_context`) via `ContextReducerTs`, with app/CLI wiring and integration tests.
- 2026-02-12: Closed chronicle lifecycle automation + autochronicler parity slice:
  - Added `ChronicleLifecycleTs` for chapter rollover, chapter-close summary generation, and recap insertion (`chronicler.paragraphs_per_chapter`, `chronicler.model`, `chronicler.arc_models`).
  - Added `AutoChroniclerTs` and wired trigger semantics into shared command handler direct+passive paths (threshold, lookback, overlap, per-arc locking).
  - Wired app + CLI runtime chronicler setup (`chronicle.db`, lifecycle/autochronicler wiring) and command-path tool executor context so `chronicle_append` uses lifecycle automation when available.
  - Kept quests/proactive runtime deferred policy unchanged (`chronicler.quests`, `quests`, `rooms.*.proactive`).
- 2026-02-12: Closed chapter-context prepending parity and lower-priority runtime gaps:
  - Added command-path `include_chapter_summary` parity in `RoomCommandHandlerTs` (chapter context prepending by default, disabled via mode config or `!c` no-context path).
  - Added TS chronicle quest internals (`ChronicleStore` quest schema/methods + `QuestRuntimeTs` paragraph hook/heartbeat runtime + unresolved quest carryover during chapter rollover).
  - Closed IRC per-event concurrency throughput delta by dispatching event handlers concurrently in `IrcRoomMonitor.run`.
  - Added regression tests for chapter-context prepending, quest lifecycle/heartbeat internals, unresolved quest chapter rollover carryover, and IRC concurrent event dispatch behavior.
- 2026-02-12: Closed final accidental parity stretch for parity-v1 scope:
  - Added command-path cost follow-up + daily arc-cost milestone messaging parity in `RoomCommandHandlerTs`.
  - Added Discord typing indicator lifecycle parity around direct command handling in monitor+transport.
  - Added runner-side vision fallback parity: switch to configured `vision_model` when image-producing tool output appears, with fallback suffix in final response.
  - Added targeted tests in `ts/tests/command-handler.test.ts`, `ts/tests/discord-monitor.test.ts`, and `ts/tests/muaddib-agent-runner.test.ts`.

---

## Rewrite objective
Rewrite muaddib from Python to TypeScript using:
- `@mariozechner/pi-ai`
- `@mariozechner/pi-agent-core`

while preserving core service behavior and configuration semantics.

### Scope target
- ✅ Core room/command runtime across IRC, Discord, Slack
- ✅ Shared command routing + classifier + agent execution
- ✅ Persistent history + chronicle storage compatibility
- ✅ CLI message mode parity path
- ✅ Config-first behavior and strict `provider:model` model references
- ◐ Quests runtime internals implemented (storage/lifecycle/heartbeat), operator enablement remains deferred by policy
- ❌ Proactive interjections runtime support (deferred)

---

## Stable architecture decisions

1. **Parallel runtime strategy (TS-first with rollback path)**
   - TS runtime is primary.
   - Python runtime remains an explicit rollback path during soak window.

2. **No legacy compatibility shims**
   - Rewrite behavior is explicit and fail-fast.
   - Tests/docs are aligned to the current schema and contracts.

3. **Provider/model resolution contract**
   - Models must be fully qualified as `provider:model`.
   - TS resolves provider/model through pi-ai adapter layer (no custom provider SDK wrappers).

4. **Agent loop contract**
   - TS uses `Agent`/tool integration from `pi-agent-core` instead of Python custom actor loop.
   - Room policy, command resolution, and orchestration remain in app layer.

5. **Storage continuity where practical**
   - TS keeps compatible semantics for chat history, LLM call logging, and chronicle tables.
   - Goal: preserve migration and operational continuity.

6. **Fail-fast operational policy**
   - Invalid or unsupported config fails fast with operator-guidance errors.
   - No broad defensive exception swallowing.

---

## Implemented TS functionality snapshot

### App/runtime
- TS main/bootstrap runtime with room monitor orchestration.
- Runtime-mode deployment entrypoint supports TS default and Python rollback override.
- Structured runtime logging to stdout + `$MUADDIB_HOME/logs/YYYY-MM-DD/system.log`.
- Per-message context-sharded logs for handled messages.

### Command/agent path
- Shared room command resolver and command handler.
- Mode classifier prompt support.
- Agent runner with context replay, iterative tool-loop semantics, iteration cap, and non-empty completion retries.
- LLM call logging/persistence hooks.

### Rooms/transports
- IRC varlink client/sender + monitor (reconnect and event-loop isolation behavior).
- Discord transport + monitor.
- Slack transport + monitor.
- Shared send retry helper with bounded rate-limit retries.

### Data/storage
- SQLite chat history store (messages/context + llm_calls linkages).
- Chronicle storage + lifecycle automation maintained (chapter rollover, summaries, recap insertion, unresolved-quest carryover, and autochronicler trigger flow).
- Quest persistence/lifecycle internals implemented in chronicle storage/runtime (`quest_*` methods + heartbeat runtime scaffolding), with operator-facing enablement still policy-deferred.
- Platform-id update plumbing for message edit parity in adapters.

### CLI
- TS CLI message mode path wired through shared command logic.

---

## Python vs TypeScript: important differences (authoritative)

## 1) Deferred feature surface
Python supports runtime automation for:
- chronicling automation,
- quests,
- proactive interjections.

TS runtime behavior:
- core chronicler runtime behavior is now supported,
- quest persistence/lifecycle internals are implemented in TS chronicler components,
- deferred keys are now `chronicler.quests`, `quests`, and `rooms.*.proactive`,
- inactive deferred-key presence is tolerated with warning,
- explicit deferred-key enablement (`enabled: true`) is fail-fast rejected.

## 2) Credential contract difference
Python historically had broader credential permutations.

TS currently supports only:
- static string `providers.<provider>.key`, or
- provider SDK env-var fallback.

TS explicitly rejects (fail-fast):
- non-string `providers.*.key`,
- `providers.*.oauth`,
- `providers.*.session`.

OAuth/session refresh plumbing is intentionally deferred pending stable upstream contract.

## 3) Agent/runtime implementation difference
- Python: custom provider clients + custom actor loop.
- TS: pi-ai + pi-agent-core (`Agent`) foundation.

Behavioral goal remains parity at app-level command/room behavior, not implementation identity.

## 4) Logging implementation nuance
- TS now mirrors Python-style message-sharded log routing and lifecycle markers.
- Intentional difference: TS uses append-per-write behavior and does **not** implement Python’s open-file LRU handle cache.

## 5) Error policy surface
- TS aggressively fail-fast validates unsupported/deferred config to avoid ambiguous runtime behavior.
- This is stricter than legacy permissive/implicit behavior paths.

---

## Rollout and correctness guardrails

- TS-first runtime cutover is active with explicit Python rollback controls.
- Exit/deprecation criteria and operator evidence requirements are defined in:
  - `docs/typescript-runtime-rollout.md`
  - `docs/typescript-runtime-runbook.md`
  - `docs/typescript-runtime-soak-evidence-template.md`
  - `docs/typescript-runtime-soak-evidence-log.md`

Python rollback path must remain available until soak/parity/SLO gates are fully satisfied.

---

## Remaining gaps / next parity work

1. **Post-tooling parity follow-up gaps (current accidental backlog)**
   - TS now covers multi-turn tool loop semantics + core tools (`web_search`, `visit_webpage`, `execute_code`), artifact tools (`share_artifact`, `edit_artifact`), advanced tools (`oracle`, `generate_image`), chronicler/quest tool-surface names, command-path refusal-fallback behavior, persistence-summary callback flow (`tools.summary.model`), `response_max_bytes` long-response artifact fallback, transport UX parity (reply-edit debounce + Slack mention formatting/typing lifecycle + Discord typing indicator lifecycle), reconnect boundary semantics, command-path context reduction, chapter-context prepending (`include_chapter_summary`), chronicle lifecycle automation + autochronicler triggers, quest persistence/heartbeat internals, IRC per-event concurrency, command-path cost follow-up milestones, and runner vision fallback behavior.
   - No known accidental parity gaps remain in parity-v1 scope at this time; remaining work is policy/deployment oriented (deferred quest/proactive enablement, credential refresh contract, soak evidence).

2. **OAuth/session credential refresh support**
   - Still deferred; blocked on stable upstream provider refresh contract.

3. **Deferred Python-only runtime feature enablement**
   - quest operator enablement via deferred config keys (`chronicler.quests`, `quests`),
   - proactive interjections.

4. **Soak evidence completion**
   - Continue production parity/SLO evidence capture until all deprecation gates are green.

5. **Final parity verification before Python removal**
   - Confirm no unresolved functional/architectural gaps remain before deprecating rollback path.

---

## Current focus
Use the authoritative parity audit as the execution backlog:
- `docs/typescript-parity-audit.md`

Immediate priority from the parity audit is maintaining soak evidence/docs parity and rollback-window guardrails while deferred proactive/quest operator enablement remains out of scope by policy.
