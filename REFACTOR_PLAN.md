# Config & Runtime Refactoring Plan

Status: Steps 1-8 done. Step 9 next.

## Context

The initial refactoring (commit 96f189a) created `MuaddibConfig` and `MuaddibRuntime`
but took shortcuts: `config.raw` escape hatch used 5 times in `runtime.ts`, room configs
still `as any` everywhere, `CommandHandlerOptions` unchanged at ~20 fields, room monitors
don't own their config extraction, duplicated `asRecord()` in 4 files.

This plan pays off the remaining debt, organized by component for efficient
context usage per session. Each step is a self-contained commit.

## Constraints (all steps)

- All existing tests must pass: `timeout 30 npm test 2>&1 | tail -40`
- Typecheck: `npm run typecheck`
- E2e sanity: `MUADDIB_HOME=. npm run cli:message -- --message "test"`
- Prefer updating existing tests over adding new ones
- `git add -u` not `git add -A`
- Commit after each step

---

## Step 1: `src/app/refusal-fallback.ts` ✅

- Change `resolveRefusalFallbackModel` to accept `MuaddibConfig` instead of
  `Record<string, unknown>`
- Use `config.getRouterConfig().refusalFallbackModel` for the raw value
- Delete local `asRecord()` helper
- Update caller in `src/runtime.ts` (drop one `config.raw` usage)
- Update tests if any reference the old signature

## Step 2: `src/app/persistence-summary.ts` ✅

- Change `resolvePersistenceSummaryModel` to accept `MuaddibConfig`
- Use `config.getToolsConfig().summary?.model` for the raw value
- Delete local `asRecord()` helper
- Update caller in `src/runtime.ts` (drop one `config.raw` usage)

## Step 3: `src/models/pi-ai-model-adapter.ts` ✅

- Change `createPiAiModelAdapterFromConfig` to accept `MuaddibConfig`
- Add deepseek base URL to `MuaddibConfig` (e.g. in providers config or
  a dedicated `getDeepseekConfig()`)
- Delete local `asRecord()` and `readDeepSeekBaseUrlFromConfig()`
- Update caller in `src/runtime.ts` (drop one `config.raw` usage)

## Step 4: `src/app/api-keys.ts` ✅

- Change `createConfigApiKeyResolver` to accept `MuaddibConfig`
- Add a method to `MuaddibConfig` that exposes provider key+validation info
  (static keys map + unsupported credential paths for fail-fast)
- Update caller in `src/runtime.ts` (drop one `config.raw` usage)

## Step 5: `src/app/deferred-features.ts` ✅

- Change `assertNoDeferredFeatureConfig` to accept `MuaddibConfig`
- This module intrinsically walks unknown keys, so it may use `config.raw`
  internally — that's fine, the point is callers pass `MuaddibConfig`
- Update caller in `src/runtime.ts` (drop last `config.raw` usage)
- **Goal**: zero `config.raw` in `runtime.ts` after this step

## Step 6: Typed `RoomConfig` + IRC monitor owns its config

- Define typed `RoomConfig` interface in `src/config/muaddib-config.ts`:
  - Reuse/align with `CommandConfig` from `src/rooms/command/resolver.ts`
  - Add `VarlinkConfig`, `enabled`, `prompt_vars`, and other shared fields
  - Add IRC-specific fields (`varlink.socket_path`)
- `getRoomConfig()` returns `RoomConfig` instead of `Record<string, unknown>`
- Add `IrcRoomMonitor.fromRuntime(runtime): IrcRoomMonitor[]`
  - Checks `enabled` (default true for IRC)
  - Validates `socket_path` (fail-fast)
  - Creates handler and wires response cleaner
  - Returns `[]` if disabled
- Update `src/app/main.ts` IRC section to use `IrcRoomMonitor.fromRuntime()`
- Kill `as any` casts for IRC room config

## Step 7: Discord monitor owns its config

- Add Discord-specific fields to `RoomConfig` (`token`, `bot_name`, `reconnect`,
  `reply_edit_debounce_seconds`)
- Add `DiscordRoomMonitor.fromRuntime(runtime): DiscordRoomMonitor[]`
  - Checks `enabled` (default false)
  - Validates `token` (fail-fast)
  - Creates transport, handler, send-retry logger
  - Returns `[]` if disabled
- Update `src/app/main.ts` Discord section
- Kill `as any` casts for Discord room config

## Step 8: Slack monitor owns its config

- Add Slack-specific fields to `RoomConfig` (`app_token`, `workspaces`,
  `reply_start_thread`, `reply_edit_debounce_seconds`, `reconnect`)
- Add `SlackRoomMonitor.fromRuntime(runtime): SlackRoomMonitor[]`
  - Checks `enabled` (default false)
  - Validates `app_token` + workspaces (fail-fast)
  - Creates one monitor per workspace with transport, handler, send-retry logger
  - Returns `[]` if disabled
- Update `src/app/main.ts` Slack section
- Kill `as any` casts for Slack room config
- **Goal after steps 6–8**: `main.ts` is ~60 lines, zero `as any`, monitors own config

## Step 9: Handler takes `runtime` as primary constructor arg

- Change `RoomCommandHandlerTs` constructor to `(runtime, roomName, overrides?)`
  - `overrides`: `responseCleaner`, `runnerFactory`, `rateLimiter`,
    `contextReducer`, `onProgressReport`
  - Constructor reads everything else from `runtime`
- Delete `fromRuntime()` static method (it becomes the constructor)
- Delete `CommandHandlerOptions` interface
- Create `tests-ts/test-runtime.ts` with `createTestRuntime()` helper
  that builds a minimal `MuaddibRuntime` from `MuaddibConfig.inMemory()`
- Update all test files: `new RoomCommandHandlerTs(createTestRuntime(...), roomName, ...)`

## Step 10: Final cleanup

- Grep for orphaned `asRecord()`/`stringOrUndefined()`/`numberOrUndefined()` in `src/`
  — delete any that are no longer used (leave domain-appropriate ones in
  `slack/transport.ts`, `agent/tools/image.ts`)
- Consider deprecating or removing `config.raw` getter
- Verify no `as any` remains in config/runtime/handler/monitor paths
- Delete `REFACTOR_PLAN.md`
