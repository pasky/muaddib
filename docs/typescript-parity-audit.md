# TypeScript Parity Audit (Python vs TS)

Date: 2026-02-12

## Scope and method

This audit compares current runtime behavior by reading both implementations directly:

- Python runtime: `muaddib/`
- TypeScript runtime: `ts/src/`
- Behavioral tests: `tests/` and `ts/tests/`

The intent is to separate:

1. **Intentional divergences** (explicitly deferred / fail-fast policy), vs
2. **Accidental parity gaps** (missing TS behavior that Python currently has).

### Progress log (parity-fix execution)

- 2026-02-12 (cluster: command-path foundation / rate limiting):
  - Implemented TS command rate limiting with parity warning text (`Slow down a little, will you? (rate limiting)`).
  - Added TS test coverage proving limiter-denied requests skip runner execution and still persist user+assistant history rows.
- 2026-02-12 (cluster: command debounce/followup merge):
  - Implemented `command.debounce` in TS command handling and merged same-user followups into the current command turn.
  - Added TS history-store support for `getRecentMessagesSince(...)` with thread-aware filtering.
  - Added TS tests for debounce merge prompt behavior and thread-aware followup history retrieval.
  - Remaining in this priority lane: steering/session queue compaction semantics.
- 2026-02-12 (cluster: steering/session queue compaction parity):
  - Implemented TS steering queue state machine in `ts/src/rooms/command/steering-queue.ts` (followup collapse, thread-scoped steering keys, passive compaction policy).
  - Integrated queue/bypass handling into `RoomCommandHandlerTs.handleIncomingMessage` with queued command runner/session flow.
  - Added steering-context injection for queued followups into command execution context.
  - Extended `ts/tests/command-handler.test.ts` with followup collapse, thread-shared steering, and passive compaction scenarios.
- 2026-02-12 (cluster: agent loop/tooling parity core):
  - Replaced TS single-turn baseline with loop-aware runner semantics in `ts/src/agent/muaddib-agent-runner.ts`:
    - iterative tool-call continuation,
    - explicit iteration cap (`AgentIterationLimitError`),
    - non-empty completion retry policy,
    - final_answer tool-result fallback extraction,
    - aggregated usage across loop iterations.
  - Expanded baseline TS tool surface with core workflow tools in `ts/src/agent/tools/baseline-tools.ts` + `ts/src/agent/tools/core-executors.ts`:
    - `web_search`,
    - `visit_webpage`,
    - `execute_code`.
  - Added TS loop/tool tests in existing suites (`ts/tests/muaddib-agent-runner.test.ts`, `ts/tests/baseline-tools.test.ts`) covering iteration cap, repeated tool calls, tool-result continuation, and non-empty completion retries.
- 2026-02-12 (cluster: advanced artifact tool parity step 2):
  - Added TS baseline/executor support for `share_artifact` and `edit_artifact` in `ts/src/agent/tools/baseline-tools.ts` + `ts/src/agent/tools/core-executors.ts`.
  - Wired artifact tools to `tools.artifacts.path`/`tools.artifacts.url` with MUADDIB_HOME-relative path resolution in both runtime app path and CLI message mode (`ts/src/app/main.ts`, `ts/src/cli/message-mode.ts`).
  - Added/extended TS tests:
    - baseline tool wiring for artifact tools in `ts/tests/baseline-tools.test.ts`,
    - focused artifact write/edit executor coverage (including validation/error cases) in `ts/tests/core-executors.test.ts`.
- 2026-02-12 (cluster: advanced tool parity step 3):
  - Added TS baseline/executor support for `oracle` and `generate_image` in `ts/src/agent/tools/baseline-tools.ts` + `ts/src/agent/tools/core-executors.ts`.
  - Wired tool executor config for `tools.oracle.*`, `tools.image_gen.model`, OpenRouter base URL, and API-key resolver plumbing in runtime app + CLI command paths (`ts/src/app/main.ts`, `ts/src/cli/message-mode.ts`).
  - Added/extended TS tests:
    - baseline tool wiring tests for `oracle` + `generate_image` in `ts/tests/baseline-tools.test.ts`,
    - focused oracle/image executor success + validation/error coverage in `ts/tests/core-executors.test.ts`.
- 2026-02-12 (cluster: command refusal-fallback parity step):
  - Added TS refusal-fallback policy in command execution flow with deterministic trigger patterns for explicit refusal/error signals.
  - Wired fail-fast config validation + runtime plumbing for `router.refusal_fallback_model` (`provider:model` required, unsupported provider/model rejected) in app + CLI paths.
  - Added command-handler tests covering fallback activation (refusal text + safety error) and non-activation paths, including persisted LLM-call/provider-model assertions when fallback is used.
  - Added CLI config-validation tests for malformed/unsupported `router.refusal_fallback_model` values.
- 2026-02-12 (cluster: persistence-summary callback parity step):
  - Added TS persistence-summary callback flow in command/runner path:
    - command handler now persists callback output as assistant history rows using `[internal monologue] {message}` template,
    - runner now collects persistent tool executions and generates summary text via `tools.summary.model` before invoking callback.
  - Added fail-fast config validation + runtime plumbing for `tools.summary.model` (`provider:model` required, unsupported provider/model rejected) in app + CLI paths.
  - Extended tests for callback invocation/non-invocation, error logging paths, and callback persistence semantics in command history.
- 2026-02-12 (cluster: chronicler/quest tool-surface parity):
  - Added TS baseline/executor support for chronicler + quest tool names (`chronicle_read`, `chronicle_append`, `quest_start`, `subquest_start`, `quest_snooze`) in `ts/src/agent/tools/baseline-tools.ts` + `ts/src/agent/tools/core-executors.ts`.
  - Wired command-path baseline creation to pass per-message arc context (`server#channel`) into tool options (`ts/src/rooms/command/command-handler.ts`) and extended `ChronicleStore` with relative chapter rendering used by `chronicle_read` (`ts/src/chronicle/chronicle-store.ts`).
  - Kept deferred-runtime guardrails unchanged: quest executors continue returning explicit deferred-runtime rejection guidance in TS parity v1.
  - Extended tests for tool wiring/invocation and persistence semantics (`ts/tests/baseline-tools.test.ts`, `ts/tests/core-executors.test.ts`, `ts/tests/muaddib-agent-runner.test.ts`, `ts/tests/command-handler.test.ts`, `ts/tests/storage.test.ts`).
- 2026-02-12 (cluster: response-length + transport P1 parity tranche):
  - Added TS command-path `response_max_bytes` handling with Python-aligned long-response artifact fallback semantics (`RoomCommandHandlerTs` now converts oversized responses into `... full response: <artifact-url>` after publishing full text via `share_artifact`).
  - Added fail-fast validation for invalid `command.response_max_bytes` values and covered app + CLI command-path wiring/validation.
  - Extended command tests for long-response trigger/non-trigger behavior, persistence semantics, and fallback-model LLM-call linkage when artifact fallback is active.
  - Added transport/monitor parity for file context:
    - Discord monitor now injects `[Attachments]...[/Attachments]` blocks from transport attachment metadata.
    - Slack transport/monitor now propagate attachment blocks and private-file auth secrets (`http_header_prefixes`) into room messages.
    - `visit_webpage` now applies secrets-derived auth headers and uses direct fetch when auth headers are required (private URL support parity).
  - Added reconnect supervision scaffolding in Discord/Slack monitor loops (configurable reconnect policy + targeted monitor tests), with transport disconnect signals surfaced as receive-loop errors.
- 2026-02-12 (cluster: transport UX parity + reconnect policy boundaries + context reducer):
  - Added Discord reply-edit debounce semantics in TS monitor/send path:
    - rapid followups edit the previous bot reply when `reply_edit_debounce_seconds` window is active,
    - first reply keeps mention-author behavior, subsequent non-edited followups chain replies from prior bot message.
  - Added Slack reply-edit debounce parity (`chat.update` flow), outgoing mention formatting hook (`@DisplayName` -> `<@USER_ID>`), and typing-indicator lifecycle support (`assistant.threads.setStatus` set/refresh/clear).
  - Extended Slack socket transport with outgoing mention formatting cache and send/update/typing sender capabilities used by the monitor.
  - Finalized reconnect supervision policy in Discord/Slack monitors:
    - receive-loop errors are supervised/retried when reconnect is enabled,
    - `null` events are treated as graceful shutdown signals and stop monitors without reconnect.
  - Added monitor tests for boundary cases: null shutdown behavior, reconnect enabled/disabled behavior, and max-attempts exhaustion for both Discord and Slack.
  - Added TS command-path context reducer parity:
    - introduced `ContextReducerTs` (`context_reducer.model` + `context_reducer.prompt`),
    - wired `auto_reduce_context` mode behavior into resolver runtime + command execution flow,
    - updated app + CLI command paths to pass root `context_reducer` config through to the shared handler,
    - added command-handler integration coverage proving reduced context is used when enabled.
- 2026-02-12 (cluster: chronicle lifecycle automation + autochronicler wiring):
  - Added TS chronicle lifecycle automation via `ChronicleLifecycleTs`:
    - chapter rollover at `chronicler.paragraphs_per_chapter`,
    - chapter-close summary generation using `chronicler.model` / `chronicler.arc_models`,
    - recap paragraph insertion into newly opened chapter.
  - Added TS `AutoChroniclerTs` with Python-aligned trigger semantics (`history_size` threshold, lookback, overlap, per-arc locking) and wired it into shared command handler direct+passive paths.
  - Wired app + CLI runtime chronicler initialization (`chronicle.db`, lifecycle, autochronicler, tool executor context) while keeping quest/proactive deferred policy unchanged.
  - Updated chronicler tool executor path so `chronicle_append` uses lifecycle automation when runtime lifecycle hook is available.
  - Added/extended tests for lifecycle boundaries, autochronicler trigger+marking behavior, command-path autochronicler hooks, core-executor lifecycle hook wiring, and deferred-policy regression expectations.

---

## 1) Feature matrix

Legend: ✅ implemented, ◐ partial, ❌ missing, ⚠ intentional deferred

### A. Command handling + classifier behavior

| Capability | Python | TS | Notes / evidence |
|---|---:|---:|---|
| Prefix parsing (`!mode`, `!c`, `@model`, `!h`) | ✅ | ✅ | `muaddib/rooms/resolver.py::parse_prefix`, `ts/src/rooms/command/resolver.ts::parsePrefix` |
| Channel policy resolution (`classifier`, constrained classifier, forced trigger) | ✅ | ✅ | `resolve()` in both resolvers |
| LLM classifier with fallback label | ✅ | ✅ | `muaddib/rooms/command.py::classify_mode`, `ts/src/rooms/command/classifier.ts::createModeClassifier` |
| Command rate limiting + warning reply | ✅ | ✅ | Python `_handle_command_core`, TS `ts/src/rooms/command/command-handler.ts::execute` + `rate-limiter.ts` |
| Command debounce / followup coalescing | ✅ | ✅ | Python `_handle_command_core` + `history.get_recent_messages_since`; TS `command-handler.ts::collectDebouncedFollowups` + `chat-history-store.ts::getRecentMessagesSince` |
| Steering queue/session compaction | ✅ | ✅ | Python `SteeringQueue` + `_run_or_queue_command`; TS `steering-queue.ts` + queued runner integration in `command-handler.ts` |
| Context reduction integration | ✅ | ✅ | Python `MuaddibAgent.run_actor` + `ContextReducer`; TS now mirrors `auto_reduce_context` + root `context_reducer` config via `ContextReducerTs` in shared command path |
| Response length policy (artifact fallback) | ✅ | ✅ | Python `_run_actor` + `_long_response_to_artifact`; TS `RoomCommandHandlerTs` now enforces `response_max_bytes` + artifact-link fallback semantics |
| Cost follow-up/operator cost milestones | ✅ | ❌ | Python `_route_command`; TS does not emit cost followups |

### B. Room monitors / transports (IRC, Discord, Slack)

| Capability | Python | TS | Notes / evidence |
|---|---:|---:|---|
| IRC direct/passive detection + bridged sender normalization | ✅ | ✅ | `muaddib/rooms/irc/monitor.py::process_message_event`, `ts/src/rooms/irc/monitor.ts::processMessageEvent` |
| IRC reconnect with exponential backoff | ✅ | ✅ | `_connect_with_retry` / `connectWithRetry` |
| IRC event handling isolation (continue after single event failure) | ✅ | ✅ | `tests/rooms/irc/test_monitor.py`, `ts/tests/irc-monitor.test.ts` |
| IRC concurrent event handling | ✅ | ❌ | Python spawns per-event (`muaddib.spawn`), TS awaits sequentially in run loop |
| Discord message edit persistence by platform id | ✅ | ✅ | `process_message_edit` vs `processMessageEditEvent` |
| Discord attachment block injection into message content | ✅ | ✅ | Python `process_message_event` attachment handling; TS Discord transport+monitor now inject `[Attachments]` blocks |
| Discord reply-edit debounce (edit previous bot response) | ✅ | ✅ | Python `reply_edit_debounce_seconds` logic; TS monitor now edits prior bot response inside debounce window |
| Discord typing indicator while generating response | ✅ | ❌ | Python `async with message.channel.typing()`; TS none |
| Slack message edit persistence by platform id | ✅ | ✅ | Python `_handle_message_edit`; TS `processMessageEditEvent` |
| Slack attachment block + private-file auth secrets propagation | ✅ | ✅ | Python `_build_attachment_block` + `secrets`; TS Slack transport+monitor now build attachment blocks and propagate `http_header_prefixes` secrets |
| Slack reply-edit debounce (`chat_update`) | ✅ | ✅ | Python `reply_edit_debounce_seconds`; TS monitor now debounces followups via `chat.update` sender path |
| Slack mention formatting in replies (`@Name` -> `<@U...>`) | ✅ | ✅ | Python `_format_mentions_for_slack`; TS transport now provides outgoing mention formatting cache + monitor hook |
| Slack typing indicator (`assistant.threads.setStatus`) | ✅ | ✅ | Python `_set_typing_indicator` / `_clear_typing_indicator`; TS monitor+transport now set/refresh/clear typing status around direct command handling |
| Discord/Slack send retry on rate limit | ❌ | ✅ | TS `sendWithRateLimitRetry`; Python does not have unified retry helper |
| Discord/Slack monitor auto-recovery strategy | ◐ | ✅ | Python relies SDK runtime loops (`client.start`, `SocketModeHandler.start_async`); TS now has explicit reconnect supervision for receive-loop failures plus tested graceful `null` shutdown policy |

### C. History + chronicle behavior (including automation)

| Capability | Python | TS | Notes / evidence |
|---|---:|---:|---|
| SQLite chat history schema + migrations + context retrieval | ✅ | ✅ | `muaddib/history.py`, `ts/src/history/chat-history-store.ts` |
| Platform-id update for edits | ✅ | ✅ | `update_message_by_platform_id` in both stores |
| LLM call linkage (trigger + response IDs) | ✅ | ✅ | `log_llm_call` / `logLlmCall`, `update_llm_call_response` |
| Chronicle base storage (arcs/chapters/paragraphs) | ✅ | ✅ | `muaddib/chronicler/chronicle.py`, `ts/src/chronicle/chronicle-store.ts` |
| Chapter rollover + summary + recap paragraph | ✅ | ✅ | Python `chronicler/chapters.py::chapter_append_paragraph`; TS `chronicle/lifecycle.ts::ChronicleLifecycleTs.appendParagraph` |
| Auto-chronicling trigger from chat history thresholds | ✅ | ✅ | Python `rooms/autochronicler.py`; TS `rooms/autochronicler.ts::AutoChroniclerTs.checkAndChronicle` wired via `RoomCommandHandlerTs` |
| Quest tables + quest lifecycle + heartbeat | ✅ | ❌ | Python `chronicler/chronicle.py` quests methods + `chronicler/quests.py`; TS chronicle schema has no quests |
| Proactive interjection -> chronicler side effects | ✅ | ⚠ | Python in `RoomCommandHandler`; TS intentionally deferred via `assertNoDeferredFeatureConfig` |

### D. Tool / agent loop behavior

| Capability | Python | TS | Notes / evidence |
|---|---:|---:|---|
| Multi-turn agent loop with iteration cap | ✅ | ✅ | Python `AgenticLLMActor.run_agent`; TS `MuaddibAgentRunner.runSingleTurn` now enforces iterative loop + max-iteration cap |
| Tool-call execution loop with tool results fed back to model | ✅ | ✅ | Python `run_agent`; TS runner now relies on `Agent` loop semantics and validates tool-result continuation in `ts/tests/muaddib-agent-runner.test.ts` |
| Broad tool surface (web_search, visit_webpage, execute_code, oracle, artifacts, image gen, quest/chronicler tools) | ✅ | ✅ | TS now includes `web_search`/`visit_webpage`/`execute_code`, artifact tools (`share_artifact`/`edit_artifact`), advanced tools (`oracle`, `generate_image`), and chronicler/quest tool names (`chronicle_read`, `chronicle_append`, `quest_start`, `subquest_start`, `quest_snooze`) with deferred-runtime quest guardrails preserved. |
| Progress callback + persistence summary callback | ✅ | ✅ | TS runner now emits persistence-summary callbacks for persistent tool calls (`tools.summary.model`) and command path persists callback text as internal monologue history rows. |
| Refusal fallback model stickiness | ✅ | ✅ | Python `providers/ModelRouter.call_raw_with_model`; TS command path now retries explicit refusal/error outcomes with `router.refusal_fallback_model` and logs usage against the effective fallback model |
| Vision fallback when image tool output appears | ✅ | ❌ | Python `AgenticLLMActor.run_agent`; TS no equivalent |

### E. Logging / observability

| Capability | Python | TS | Notes / evidence |
|---|---:|---:|---|
| System log + per-message arc-sharded logs | ✅ | ✅ | `muaddib/message_logging.py`, `ts/src/app/logging.ts` |
| Start/finish message lifecycle markers | ✅ | ✅ | `MessageLoggingContext` / `withMessageContext` |
| File-handle LRU cache for log writers | ✅ | ❌ (intentional) | Python `MessageContextHandler`; TS append-per-write (documented intentional) |
| Send retry/failure structured lines (`[muaddib][send-retry]`, `[muaddib][metric]`) | ❌ | ✅ | TS `createSendRetryEventLogger`; required during soak |

### F. Config contracts + startup validation

| Capability | Python | TS | Notes / evidence |
|---|---:|---:|---|
| `provider:model` parsing requirement | ✅ | ✅ | Python `parse_model_spec`, TS `parseModelSpec` |
| Deferred feature knobs tolerated only when inactive; fail-fast when explicitly enabled | ❌ | ✅ (intentional) | TS `app/deferred-features.ts` |
| OAuth/session provider credential keys rejected with operator guidance | ❌ | ✅ (intentional) | TS `app/api-keys.ts` |
| Missing enabled room credentials fail-fast at startup | ◐ | ✅ | Python Discord/Slack monitors log+skip; TS throws in `createMonitors()` |
| No monitors enabled | warn+return | throw | Python `MuaddibAgent.run`; TS `runMuaddibMain` |

### G. Runtime deployment / rollback behavior

| Capability | Python | TS wrapper | Notes / evidence |
|---|---:|---:|---|
| TS-first runtime with Python rollback env switch | ✅ | ✅ | `scripts/runtime-entrypoint.sh` (`MUADDIB_RUNTIME=ts|python`) |
| Rollback window marker surfaced at startup | ✅ | ✅ | runtime entrypoint echoes `MUADDIB_TS_ROLLBACK_UNTIL` |
| TS CLI message mode path for `--message` | ✅ | ✅ | entrypoint routes to `npm run cli:message` |
| Runtime-path proof and soak process docs | ✅ | ✅ | rollout/runbook/evidence docs maintained |

---

## 2) Python functionality missing/divergent in TS (severity + impact)

### Intentional divergences (documented policy)

| Gap | Severity | Impact |
|---|---:|---|
| Deferred runtime features: quests + proactive interjections | P1 (accepted) | TS ignores inactive deferred knobs (`chronicler.quests`, `quests`, `rooms.*.proactive`) and rejects explicit enablement. |
| Credential contract narrowed to static `providers.*.key` or env var fallback; OAuth/session rejected | P1 (accepted) | Existing dynamic credential refresh configs must be removed before TS startup. |
| Message log writer no LRU file-handle cache | P2 (accepted) | Slightly different I/O behavior; functional parity is retained. |

### Accidental / not-yet-implemented parity gaps

After closing `response_max_bytes`, transport UX parity, reconnect boundary semantics, context reduction parity, and chronicle lifecycle automation, the highest-priority remaining accidental gaps are now quest runtime persistence/heartbeat continuity and lower-priority adapter/runtime throughput deltas.

| Gap | Severity | User/operator impact | Evidence |
|---|---:|---|---|
| Steering/session queue compaction in TS command path | ✅ closed (2026-02-12) | Followup command collapse, thread-shared steering context, and passive compaction semantics are now mirrored in TS command flow. | Python `_run_or_queue_command`/`SteeringQueue`; TS `ts/src/rooms/command/steering-queue.ts` + `ts/src/rooms/command/command-handler.ts` + `ts/tests/command-handler.test.ts` |
| Command rate limiting in TS | ✅ closed (2026-02-12) | Burst traffic guard restored with user-facing warning response and no runner execution when denied. | Python `_handle_command_core` uses `RateLimiter`; TS now mirrors via `ts/src/rooms/command/command-handler.ts` + `ts/src/rooms/command/rate-limiter.ts` |
| Command debounce/followup merge in TS | ✅ closed (2026-02-12) | Split/rapid user inputs are now coalesced via `command.debounce` + followup merge in TS command execution. | Python `_handle_command_core` debounce path; TS `command-handler.ts::collectDebouncedFollowups` |
| Agent loop/tooling core parity (`web_search`, `visit_webpage`, `execute_code`) | ✅ closed (2026-02-12) | TS command path now supports iterative tool loops with iteration cap and non-empty completion handling. | Python `AgenticLLMActor.run_agent`; TS `muaddib-agent-runner.ts`, `baseline-tools.ts`, `core-executors.ts`, `ts/tests/muaddib-agent-runner.test.ts` |
| Artifact tool parity in TS (`share_artifact`, `edit_artifact`) | ✅ closed (2026-02-12) | TS command path now supports core artifact sharing/edit workflows with configured artifact storage path/URL wiring. | Python `agentic_actor/tools.py::ShareArtifactExecutor`, `EditArtifactExecutor`; TS `baseline-tools.ts`, `core-executors.ts`, `app/main.ts`, `cli/message-mode.ts`, `ts/tests/core-executors.test.ts` |
| Advanced tool parity step 3 in TS (`oracle`, `generate_image`) | ✅ closed (2026-02-12) | TS command path now includes oracle and image-generation tool wiring/executors with validation/error coverage. | Python `agentic_actor/tools.py::TOOLS`; TS `baseline-tools.ts`, `core-executors.ts`, `app/main.ts`, `cli/message-mode.ts`, `ts/tests/baseline-tools.test.ts`, `ts/tests/core-executors.test.ts` |
| Remaining chronicler/quest tools parity | ✅ closed (2026-02-12) | TS baseline now includes chronicler/quest tool names and executor wiring; quest executors keep explicit deferred-runtime rejection semantics in parity v1. | Python `agentic_actor/tools.py::TOOLS`; TS `baseline-tools.ts`, `core-executors.ts`, `command-handler.ts`, `chronicle-store.ts`, `ts/tests/baseline-tools.test.ts`, `ts/tests/core-executors.test.ts`, `ts/tests/muaddib-agent-runner.test.ts` |
| Refusal fallback model behavior in TS command/app path | ✅ closed (2026-02-12) | TS now retries on deterministic explicit refusal/error markers using `router.refusal_fallback_model`, appends fallback suffix, and persists/logs usage under the effective fallback model. | Python `providers/__init__.py::ModelRouter.call_raw_with_model`; TS `ts/src/rooms/command/command-handler.ts` + `ts/src/app/refusal-fallback.ts` |
| No response_max_bytes + artifact fallback in TS command path | ✅ closed (2026-02-12) | TS command path now enforces `response_max_bytes` and converts oversized responses to artifact-linked text fallback. | Python `RoomCommandHandler._run_actor/_long_response_to_artifact`; TS `RoomCommandHandlerTs.applyResponseLengthPolicy` |
| Discord attachments not injected into prompt context in TS | ✅ closed (2026-02-12) | TS Discord monitor now preserves attachment context via `[Attachments]...[/Attachments]` blocks. | Python `rooms/discord/monitor.py::process_message_event`; TS `rooms/discord/monitor.ts` + `rooms/discord/transport.ts` |
| Discord reply-edit debounce missing in TS | ✅ closed (2026-02-12) | TS Discord monitor now merges rapid followups by editing the previous bot reply inside `reply_edit_debounce_seconds`. | Python `reply_edit_debounce_seconds` logic |
| Slack attachments + secrets propagation missing in TS | ✅ closed (2026-02-12) | TS Slack transport/monitor now append attachment context and propagate private-file auth secrets for tool fetches. | Python `rooms/slack/monitor.py::process_message_event`; TS `rooms/slack/transport.ts`, `rooms/slack/monitor.ts`, `agent/tools/core-executors.ts` |
| Slack reply-edit debounce missing in TS | ✅ closed (2026-02-12) | TS Slack monitor now consolidates rapid followups with `chat.update` semantics. | Python `reply_edit_debounce_seconds` logic |
| Slack mention-formatting for outgoing replies missing in TS | ✅ closed (2026-02-12) | TS Slack sender now formats `@DisplayName` mentions to `<@USER_ID>` when cached mapping is available. | Python `_format_mentions_for_slack` |
| Slack typing indicator lifecycle missing in TS | ✅ closed (2026-02-12) | TS Slack monitor/transport now set, refresh, and clear typing status around direct command handling. | Python `_set_typing_indicator` / `_clear_typing_indicator` |
| Context reducer parity in TS command path | ✅ closed (2026-02-12) | TS command path now supports root `context_reducer` config + mode `auto_reduce_context` behavior through `ContextReducerTs`. | Python `ContextReducer` + `RoomCommandHandler._run_actor` |
| Quest tables + quest lifecycle/heartbeat runtime missing in TS | P1 | Chronicle lifecycle automation now exists, but quest persistence/continuity runtime remains deferred in parity v1. | Python `chronicler/chronicle.py` quests schema/methods, `chronicler/quests.py` |
| Discord/Slack null-event supervision policy not explicit in TS docs/tests | ✅ closed (2026-02-12) | TS now codifies/tests policy: receive errors reconnect under policy; `null` events are graceful shutdown signals without reconnect. | `ts/src/rooms/discord/monitor.ts::run`, `ts/src/rooms/slack/monitor.ts::run`, monitor test boundary cases |
| IRC monitor processes events serially (no per-event task spawn) | P2 | Head-of-line blocking during long command turns; throughput degradation under load. | Python `muaddib.spawn(self.process_message_event(event))` vs TS `await this.processMessageEvent(event)` |

---

## 3) Architecture correctness assessment (TS)

### A. State handling and sequencing

- **Good:** per-message history persistence and direct/passive branching are centralized (`RoomCommandHandlerTs.handleIncomingMessage`), reducing adapter divergence.
- **Good:** steering/session queue compaction parity is now implemented in TS (`steering-queue.ts`) with queue-aware command/passive sequencing.
- **Residual risk:** quest lifecycle runtime remains deferred (no quest tables/heartbeat automation), so long-horizon autonomous quest continuity is still narrower in TS even though tool-surface names now exist.

### B. Reconnect behavior

- **IRC:** reasonably robust (retry + reconnect + mynick cache reset) in TS.
- **Discord/Slack:** TS now includes configurable reconnect supervision for receive-loop failures, with transport disconnect signals surfaced as errors and targeted monitor tests.
- **Policy now explicit/tested:** `null` receive events are treated as graceful shutdown signals (no reconnect), while receive-loop errors enter supervised reconnect flow.

### C. Error isolation

- **Good:** monitor loops wrap per-event processing in try/catch and continue on handler exceptions (`irc`, `discord`, `slack` tests explicitly cover this).
- **Good:** reconnect boundaries (enabled/disabled, max-attempt exhaustion, null-shutdown behavior) now have explicit monitor tests for both Discord and Slack.

### D. Persistence correctness

- **Good:** TS history schema parity includes trigger/response linkage and edit updates by platform id.
- **Known limitations (shared with Python):** no dedupe/idempotency key for replayed platform events; duplicate inbound events can duplicate rows.

### E. Idempotency + race risks

- **Race reduced by serialization:** TS monitor loops process one event at a time.
- **Trade-off:** serialization introduces head-of-line blocking and weakens parity with Python’s concurrent event processing + steering queue model.

---

## 4) Prioritized remediation plan (minimal-risk sequence)

## Phase 0 — reliability guardrails (first)

1. ✅ **Add Discord/Slack reconnect supervision in monitors** (retry loop with bounded backoff, no silent exit on transient disconnect), including explicit null-event shutdown policy and boundary tests. *(Completed 2026-02-12)*
2. ✅ **Add command rate limiting parity** in `RoomCommandHandlerTs` (`rate_limit`, `rate_period`) with user-facing warning response. *(Completed 2026-02-12)*

Tests (red/green):
- ✅ Extended `ts/tests/discord-monitor.test.ts` + `ts/tests/slack-monitor.test.ts` with reconnect boundary scenarios (null shutdown, reconnect disabled/enabled, max-attempt exhaustion).
- ✅ Extended `ts/tests/command-handler.test.ts` with rate-limit deny path and persisted warning behavior.

## Phase 1 — command-path behavioral parity

3. ✅ **Implement TS steering queue/session model** equivalent to Python (`SteeringQueue` semantics, thread-sharing, compaction policy). *(Completed 2026-02-12)*
4. ✅ **Implement command debounce/followup merge** (`command.debounce` + recent messages merge). *(Completed 2026-02-12)*
5. ✅ **Implement context reducer parity in command path** (`context_reducer` root config + mode `auto_reduce_context`). *(Completed 2026-02-12)*

Tests (red/green):
- Port/translate Python steering tests from `tests/rooms/test_command.py`:
  - followup command collapse,
  - thread-shared steering,
  - passive compaction behavior.
- ✅ Added debounce behavior tests in `ts/tests/command-handler.test.ts` and thread-aware followup retrieval tests in `ts/tests/storage.test.ts`.
- ✅ Added command-handler integration coverage proving reduced context injection when `auto_reduce_context` is enabled.

## Phase 2 — agent/tool parity core (highest product impact)

6. ✅ **Replace single-turn runner wrapper with multi-turn tool loop** around pi-agent-core state/events.
7. ✅ **Expand tool surface incrementally**:
   - ✅ step 1: `web_search`, `visit_webpage`, `execute_code`,
   - ✅ step 2: `share_artifact`, `edit_artifact`,
   - ✅ step 3: `oracle`, `generate_image`,
   - ✅ step 4: chronicler/quest tool-surface names (`chronicle_read`, `chronicle_append`, `quest_start`, `subquest_start`, `quest_snooze`) with deferred-runtime quest guardrails.
8. ✅ **Add refusal fallback policy** equivalent to Python router behavior in TS command path with deterministic explicit refusal/error trigger policy and `router.refusal_fallback_model` validation/wiring. *(Completed 2026-02-12)*

Tests (red/green):
- ✅ Extended TS runner tests for:
  - iterative tool-call loop,
  - iteration cap,
  - tool-result continuation,
  - non-empty completion retry behavior.
- ✅ Extended baseline/executor/runner/command tests for core + artifact + advanced + chronicler/quest tool wiring (`web_search`, `visit_webpage`, `execute_code`, `share_artifact`, `edit_artifact`, `oracle`, `generate_image`, `chronicle_read`, `chronicle_append`, `quest_start`, `subquest_start`, `quest_snooze`) and focused persistence-summary semantics.
- Remaining in this lane: quest runtime persistence/heartbeat surfaces and broader deferred-runtime behavior.

## Phase 3 — adapter UX/completeness parity

9. ✅ **Discord reply-edit debounce parity**. *(Completed 2026-02-12)*
10. ✅ **Slack reply-edit debounce, mention formatting, typing indicators parity**. *(Completed 2026-02-12)*

Tests (red/green):
- ✅ Extended TS Discord/Slack monitor suites with reply-edit debounce, mention formatting hook, and typing lifecycle coverage.

## Phase 4 — deferred feature re-entry (policy-gated)

11. When product scope allows, re-enable deferred quest runtime + proactive interjections in TS behind explicit parity gates.

Tests (red/green):
- Port Python chronicler/proactive behavior tests (`tests/rooms/irc/test_autochronicler.py`, `tests/chronicler/*`, `tests/rooms/test_proactive.py`) in staged slices.

---

## 5) Recommended acceptance gates before Python rollback-path removal

1. All **P0/P1 accidental gaps** above either:
   - implemented with passing TS tests, or
   - explicitly reclassified as intentional with operator sign-off.
2. Discord/Slack reconnect behavior proven in soak logs (no manual restarts for transient disconnects).
3. Tool-capability parity for core workflows (search/web/code/artifact) demonstrated by TS e2e runs.
4. Steering/session behavior parity tests passing in TS.
5. Existing rollout/runbook/soak evidence docs updated with these gate checks.
