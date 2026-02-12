# TypeScript Rewrite Plan (pi-ai + pi-agent-core)

## Purpose
Keep a compact, up-to-date plan for the TypeScript runtime rewrite, focused on:
- stable design decisions,
- implemented functionality,
- important Python vs TS behavioral differences,
- remaining parity gaps.

Historical milestone-by-milestone notes were intentionally removed; use git history for full chronology.

Latest update:
- 2026-02-12: Switched TS parity-fix stream validation to TS-only (`cd ts && npm run typecheck && npm test`) and started closing parity-audit backlog incrementally.
- 2026-02-12: Added `docs/typescript-parity-audit.md` with a code-referenced Python-vs-TS matrix, severity-ranked gaps, architecture risks, and remediation plan.
- 2026-02-12: Closed TS command debounce/followup merge parity gap (`command.debounce` + thread-aware followup coalescing in command path).
- 2026-02-12: Closed TS steering/session queue compaction parity gap (`steering-queue.ts` + queued command/session integration in `RoomCommandHandlerTs` + queue scenario tests). Next priority accidental gap: agent loop/tooling parity (TS still single-turn with baseline tools only).

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
- ❌ Quests runtime support (deferred)
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
- Agent runner with context replay and baseline tools integration.
- LLM call logging/persistence hooks.

### Rooms/transports
- IRC varlink client/sender + monitor (reconnect and event-loop isolation behavior).
- Discord transport + monitor.
- Slack transport + monitor.
- Shared send retry helper with bounded rate-limit retries.

### Data/storage
- SQLite chat history store (messages/context + llm_calls linkages).
- Chronicle storage primitives maintained for compatibility.
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
- these keys are recognized as deferred (`chronicler`, `chronicler.quests`, `quests`, `rooms.*.proactive`),
- inactive presence is tolerated with warning,
- explicit enablement (`enabled: true`) is fail-fast rejected.

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

1. **Agent loop/tooling parity (highest accidental gap)**
   - TS command execution still uses single-turn runner + baseline tool surface.
   - Next parity cluster should implement multi-turn tool loop behavior and expand tool coverage toward Python core workflows.

2. **OAuth/session credential refresh support**
   - Still deferred; blocked on stable upstream provider refresh contract.

3. **Deferred Python-only runtime features**
   - chronicler automation,
   - quests,
   - proactive interjections.

4. **Soak evidence completion**
   - Continue production parity/SLO evidence capture until all deprecation gates are green.

5. **Final parity verification before Python removal**
   - Confirm no unresolved functional/architectural gaps remain before deprecating rollback path.

---

## Current focus
Use the authoritative parity audit as the execution backlog:
- `docs/typescript-parity-audit.md`

Immediate priority is the next accidental P0 gap from that audit: multi-turn agent-loop/tooling parity beyond the current single-turn baseline.
