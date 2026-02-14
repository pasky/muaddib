# Config & Runtime Refactoring Plan

Status: Phase 1a next.

## Context

The initial refactoring (commit 96f189a) created `MuaddibConfig` and `MuaddibRuntime`
but took shortcuts: `config.raw` escape hatch used 5 times in `runtime.ts`, room configs
still `as any` everywhere, `CommandHandlerOptions` unchanged at ~20 fields, room monitors
don't own their config extraction, duplicated `asRecord()` in 4 files.

This plan pays off the remaining debt properly.

---

## Phase 1: Make `MuaddibConfig` the single source of truth

### Phase 1a: Migrate config consumers to accept `MuaddibConfig`

Files to change:
- `src/app/refusal-fallback.ts` — use `config.getRouterConfig().refusalFallbackModel`
  instead of manual `asRecord` chain. Delete local `asRecord()`.
- `src/app/persistence-summary.ts` — use `config.getToolsConfig().summary.model`.
  Delete local `asRecord()`.
- `src/models/pi-ai-model-adapter.ts` — add `getDeepseekConfig()` to `MuaddibConfig`
  (or reuse providers config), use it in `createPiAiModelAdapterFromConfig()`.
  Delete local `asRecord()`.
- `src/app/api-keys.ts` — add `getProviderKeys(): Map<string, string>` to `MuaddibConfig`.
  Refactor `createConfigApiKeyResolver()` to accept `MuaddibConfig`.
- `src/app/deferred-features.ts` — keep taking raw (intrinsically about unknown keys),
  or add a `getRawSection(key)` accessor.
- `src/runtime.ts` — eliminate all `config.raw` usages.

**Goal**: zero `config.raw` in `runtime.ts`.

**Validation**: `npm run typecheck`, `timeout 30 npm test`, e2e sanity.

### Phase 1b: Typed `RoomConfig` interface

- Define `RoomConfig` in `src/config/muaddib-config.ts` with typed sub-interfaces:
  - `CommandConfig` (already exists in `src/rooms/command/resolver.ts` — reuse or align)
  - `VarlinkConfig` (`socket_path: string`)
  - Room-specific: `token`, `app_token`, `workspaces`, `bot_name`, `enabled`,
    `reconnect`, `reply_edit_debounce_seconds`, `reply_start_thread`, `prompt_vars`
- `getRoomConfig()` returns `RoomConfig` instead of `Record<string, unknown>`
- Kill all `as any` casts on room configs in `main.ts`, `runtime.ts`, `command-handler.ts`

**Files**: `src/config/muaddib-config.ts`, `src/app/main.ts`, `src/runtime.ts`,
`src/rooms/command/command-handler.ts`

**Validation**: same + grep for `as any` in those files should be zero.

---

## Phase 2: Slim down `CommandHandlerOptions`

### Phase 2a: Split runtime-derived vs per-instance concerns

`CommandHandlerOptions` should only contain things that vary per handler instance
and can't be derived from runtime:
- `responseCleaner` — per-room (IRC newline flattening)
- `runnerFactory` — test injection
- `rateLimiter` — test injection
- `contextReducer` — test injection
- `onProgressReport` — per-room callback
- `helpToken`, `flagTokens` — if ever per-room

Everything else comes from runtime:
- `history`, `getApiKey`, `modelAdapter` — from `runtime.*`
- `autoChronicler`, `chronicleStore` — from `runtime.*`
- `refusalFallbackModel`, `persistenceSummaryModel` — from `runtime.*`
- `agentLoop` — from `runtime.config.getActorConfig()`
- `toolOptions` — from `runtime.config.getToolsConfig()` + `runtime.*`
- `contextReducerConfig` — from `runtime.config.getContextReducerConfig()`
- `classifyMode` — derivable from `runtime` + room command config
- `roomConfig` — from `runtime.config.getRoomConfig(roomName)`

### Phase 2b: Shrink `CommandHandlerOptions`, keep one constructor

- Keep one constructor taking `CommandHandlerOptions` — tests use it directly with
  only the fields they care about, that's a fine test API
- Shrink `CommandHandlerOptions` by grouping runtime-derivable fields under an
  optional `runtime?: MuaddibRuntime` field — constructor pulls defaults from it
  when individual fields aren't provided
- `fromRuntime()` stays as production sugar (calls the constructor with `runtime` set)
- Tests keep working unchanged — they pass `history`, `classifyMode`, `runnerFactory`
  etc. directly without ever constructing a runtime

**Files**: `src/rooms/command/command-handler.ts`

**Validation**: same + `CommandHandlerOptions` shrinks but stays backward-compatible.

---

## Phase 3: Room monitors own their config

### Phase 3a: Static factories on each monitor

- `IrcRoomMonitor.fromRuntime(runtime): IrcRoomMonitor[]`
  - Extracts `varlink.socket_path` from `runtime.config.getRoomConfig("irc")`
  - Validates socket_path (fail-fast)
  - Creates handler via `RoomCommandHandlerTs(runtime, "irc", { responseCleaner })`
  - Returns `[]` if room disabled, `[monitor]` if enabled
- `DiscordRoomMonitor.fromRuntime(runtime): DiscordRoomMonitor[]`
  - Extracts token, creates transport+handler
  - Returns `[]` if disabled
- `SlackRoomMonitor.fromRuntime(runtime): SlackRoomMonitor[]`
  - Extracts app_token + workspaces
  - Returns one monitor per workspace, `[]` if disabled

### Phase 3b: Simplify `main.ts`

Target:
```ts
const runtime = await createMuaddibRuntime({ configPath });
const monitors = [
  ...IrcRoomMonitor.fromRuntime(runtime),
  ...DiscordRoomMonitor.fromRuntime(runtime),
  ...SlackRoomMonitor.fromRuntime(runtime),
];
```

- `isRoomEnabled()` moves into each monitor's `fromRuntime()`
- `requireNonEmptyString()` validation moves into each monitor
- `main.ts` drops from ~220 lines to ~40 (plus send-retry logger, entry point boilerplate)

**Files**: `src/rooms/irc/monitor.ts`, `src/rooms/discord/monitor.ts`,
`src/rooms/slack/monitor.ts`, `src/app/main.ts`

**Validation**: same + `wc -l src/app/main.ts` should be ~60.

---

## Phase 4: Clean up the periphery

- Delete all orphaned `asRecord()`/`stringOrUndefined()`/`numberOrUndefined()` copies
  (leave `slack/transport.ts` and `agent/tools/image.ts` — different domain usage)
- Extract `createTestRuntime()` helper in test utils to reduce boilerplate across
  ~15 test cases that manually build `RoomCommandHandlerTs`
- Consider removing `config.raw` getter or marking it `@deprecated`

**Validation**: `grep -rn 'asRecord' src/` should show only domain-appropriate usages
(slack transport, image tool), not config-parsing copies.

---

## Constraints (all phases)

- All existing tests must pass: `timeout 30 npm test 2>&1 | tail -40`
- Typecheck: `npm run typecheck`
- E2e sanity: `MUADDIB_HOME=. npm run cli:message -- --message "test"`
- Prefer updating existing tests over adding new ones
- `git add -u` not `git add -A`
- Commit after each phase
