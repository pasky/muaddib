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

### Phase 2a: Handler stores `runtime`, reads config lazily

The handler should store `runtime` as a first-class field and read config from it
in its methods — not receive 20 pre-extracted values at construction time.

Production constructor: `(runtime: MuaddibRuntime, roomName: string, overrides?)`
- `overrides` is a small interface for per-instance concerns:
  - `responseCleaner` — per-room (IRC newline flattening)
  - `runnerFactory` — test/prod injection
  - `rateLimiter` — test injection
  - `contextReducer` — test injection
  - `onProgressReport` — per-room callback

The constructor derives everything else from `runtime`:
- `this.history = runtime.history`
- `this.modelAdapter = runtime.modelAdapter`
- `this.commandConfig = runtime.config.getRoomConfig(roomName).command`
- Builds `classifyMode` from command config + runtime
- Reads `agentLoop` from `runtime.config.getActorConfig()` when needed
- Reads `toolOptions` from `runtime.config.getToolsConfig()` when needed
- Gets `refusalFallbackModel`, `chronicleStore`, etc. from `runtime.*`

Delete `fromRuntime()` — it becomes the constructor itself.

### Phase 2b: Test helper builds a minimal runtime

Tests construct a `MuaddibRuntime` via a shared test helper in `tests-ts/`:

```ts
// tests-ts/test-runtime.ts
function createTestRuntime(opts: {
  roomConfig: any;
  history: ChatHistoryStore;
  runnerFactory?: CommandRunnerFactory;
  ...
}): MuaddibRuntime {
  return {
    config: MuaddibConfig.inMemory({ rooms: { common: opts.roomConfig } }),
    history: opts.history,
    modelAdapter: new PiAiModelAdapter(),
    getApiKey: () => undefined,
    logger: ...,
  };
}
```

Existing tests change from `new RoomCommandHandlerTs({ roomConfig, history, ... })`
to `new RoomCommandHandlerTs(createTestRuntime({ ... }), "irc", { ... })`.

No test-only code in production. The handler has one constructor, one API.

**Files**: new `tests-ts/test-runtime.ts`, all test files that construct handlers

**Validation**: same + `CommandHandlerOptions` interface deleted,
no `forTesting` / test-only paths in `src/`.

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
