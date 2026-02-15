# Code Review Notes

Accumulated during directory-by-directory review of `src/`.
Goal: identify (a) coding standards to formalize, (b) concrete cleanup opportunities.

---

## src/config/

### (a) Standards to formalize

1. **Config parsing should fail loudly on bad input, not silently coerce.** The helpers `stringOrUndefined`, `numberOrUndefined`, `asRecord` silently swallow invalid config values (wrong types, negative numbers, empty strings) — returning `undefined` instead of throwing. This means a typo like `"max_iterations": "ten"` silently becomes `undefined` and the caller falls back to a default, with no indication anything is wrong. **Standard: config parsing must throw on values that are present but have the wrong type.**

2. **Don't hand-roll JSON-to-typed-object mapping.** The entire `MuaddibConfig` class is a manually-written JSON deserializer with ~200 lines of boilerplate getter methods. This is what schema validation libraries (zod, ajv, typebox) solve. **Standard: use a schema validation library for config parsing; derive TypeScript types from schemas.**

3. **`isObject` is defined twice** — once in `deferred-features.ts` and once in `muaddib-config.ts`. Both are identical. **Standard: don't duplicate utility functions across files.**

### (b) Concrete cleanup opportunities

1. **`stringOrUndefined`, `numberOrUndefined`, `asRecord`, `toStringRecord`, `toSlackWorkspaces`** — These are all one-off normalization helpers that exist only because config is parsed from untyped `Record<string, unknown>`. With a schema validator, all of these disappear. Even without one, `numberOrUndefined` silently accepting string-encoded numbers (`Number("42")`) and silently dropping negatives is a bug factory.

2. **`deepMergeConfig` has domain-specific special cases baked in** (`ignore_users` gets concatenated, `prompt_vars` strings get concatenated). This makes a "generic" merge function secretly aware of room config semantics. Either: (a) make it truly generic and handle the special cases at the call site, or (b) rename it to `mergeRoomConfigs` and put it near the room config code.

3. **`deferred-features.ts` is over-engineered for what it does.** It defines 3 local helper functions (`isObject`, `hasOwn`, `isExplicitlyEnabled`), a `DeferredFeatureLogger` interface, and builds/deduplicates/sorts two arrays — all to check exactly one feature key (`quests`) in two possible locations. The dedup/sort is especially pointless: `blockingPaths` and `ignoredPaths` can each have at most 2 entries, and they're string literals, so duplicates are impossible in practice. The whole file could be ~15 lines: check if `quests` is in the config, throw if enabled, warn if present but disabled.

4. **`loadConfig` in `paths.ts` duplicates `MuaddibConfig.load`** — both read and parse a JSON config file. `loadConfig` returns a raw `Record`, `MuaddibConfig.load` wraps it. If callers need raw records, they should use `MuaddibConfig.toObject()`. One of these should go.

5. **`expandHomePath` in `paths.ts`** — used only inside `resolveMuaddibPath` and `getMuaddibHome`. Fine as a private helper, but Node's `resolve` + setting HOME would also work. Minor.

6. **`MuaddibConfig.getProvidersConfig()`** has a silent compat shim: `stringOrUndefined(deepseek?.url) ?? stringOrUndefined(deepseek?.base_url)`. Per AGENTS.md: "No backwards compatibility shims for legacy config keys." The `url` fallback should be removed; if someone has `url` in their config, it should be ignored or cause an error.

7. **`MuaddibConfig.getRoomConfig()`** is ~50 lines of manual field extraction that would be unnecessary with schema validation. Every field is individually unwrapped from `unknown` with helper calls. This is the single biggest source of boilerplate in the file.

---

## src/models/

### (a) Standards to formalize

1. **Error classes should only exist when callers discriminate on them.** `ModelSpecError` with its `code` enum is justified — callers check error codes. `PiAiModelResolutionError` is just a renamed `Error` with no extra fields — it adds nothing over a plain `Error`. **Standard: don't create custom error classes unless they carry discriminant fields that callers use.**

2. **Avoid "normalize" functions that silently fix bad input.** `normalizeProviderOverrideOptions` and `normalizeDeepSeekBaseUrl` silently clean up whatever they receive. If a config value is malformed, that should be an error at config load time, not silently patched at use time.

### (b) Concrete cleanup opportunities

1. **`normalizeProviderOverrideOptions`** — This function exists solely to apply a default to `deepseekBaseUrl`. It introduces a `NormalizedProviderOverrideOptions` type that's identical to `ProviderOverrideOptions` except fields are non-optional. This is unnecessary indirection. The default should be applied at the single point of use (`resolveDeepSeekModel`), or the `ProviderOverrideOptions` type should just have a required field with the default set at construction. Kill `NormalizedProviderOverrideOptions` and `normalizeProviderOverrideOptions`.

2. **`normalizeDeepSeekBaseUrl`** — 12 lines to strip trailing slashes and `/v1/messages` or `/messages` suffixes. This is defensive programming hiding misconfiguration. If someone puts `https://api.deepseek.com/anthropic/v1/messages` as the base URL, that's a config error — crash, don't silently fix it. At most, strip a trailing slash.

3. **`PiAiModelAdapter` constructor stores `normalizeProviderOverrideOptions(options)` and `options.getApiKey` separately** — but `ProviderOverrideOptions` is a subset of `PiAiModelAdapterOptions`. Just store the original options object.

4. **`resolvePiAiModel` (free function)** — Creates a throwaway `PiAiModelAdapter()` with no options just to call `.resolve()`. This is used for one-off resolution without an adapter instance. It's fine but should be documented as a convenience or inlined at call sites if there are few.

5. **`safeJson` + `truncateForDebug`** — Two private functions (8 + 7 lines) for debug logging truncation. `safeJson` catches serialization errors but that's extremely unlikely for objects that were just received from an API. The `Math.max(0, maxChars - 24)` magic number is fragile. Consider simplifying to `JSON.stringify(value)?.slice(0, maxChars)` with a `[truncated]` suffix.

6. **`getSupportedProviders`** — Creates a new `Set` on every call to `resolve()`. Since the provider list doesn't change at runtime, this could be computed once (lazy singleton or module-level).

7. **`DEEPSEEK_PRICING_BY_MODEL` fallback `{ input: 0, output: 0 }`** — If someone uses an unknown DeepSeek model, pricing silently becomes zero. This hides the fact that we don't know the pricing. Should either warn or throw for unknown model IDs.

8. **`createPiAiModelAdapterFromConfig`** — A one-liner factory function. Consider whether callers could just call `new PiAiModelAdapter(...)` directly. The function adds no logic beyond extracting `deepseekBaseUrl` from config, which callers could do themselves. If kept, it should live near the config code, not in the model adapter file.

---

## src/agent/

### (a) Standards to formalize

1. **Don't duplicate utility functions across files.** `emptyUsage()` is defined identically in both `session-factory.ts` and `session-runner.ts`. `safeJson` and `truncateForDebug` are also duplicated between the two files (identical implementations). **Standard: extract shared utilities to a single module.**

2. **Don't monkey-patch framework internals.** `applySystemPromptOverrideToSession` casts the session to `unknown` then to a private-field shape (`_baseSystemPrompt`, `_rebuildSystemPrompt`) and overwrites them. This is fragile — any upstream refactor breaks it silently. If pi-coding-agent doesn't expose the right API, request it upstream or find another approach. **Standard: never access private/internal fields of framework objects via `as unknown as`.**

3. **Don't silently normalize bad input; fail fast.** `normalizePositiveInteger` silently converts garbage to a fallback (same pattern flagged in Phase 1). `normalizeApiKey` trims and returns undefined for empty — fine for trimming whitespace, but the name suggests something bigger than it is. **Standard: validate at config boundaries, crash on invalid values.**

### (b) Concrete cleanup opportunities

1. **`emptyUsage()` — duplicated.** Identical function in `session-factory.ts` and `session-runner.ts`. Extract to a shared utility or import from one.

2. **`safeJson` + `truncateForDebug` — duplicated.** Identical in both files. Same fix.

3. **`normalizePositiveInteger`** — Used once (for `maxIterations`). Just inline: `const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS; if (maxIterations < 1) throw new Error(...)`. Kill the function.

4. **`normalizeApiKey`** — 4 lines to trim a string and return undefined if empty. Used in two places in `MuaddibConfigBackedAuthBridge`. Inline it: `value.trim() || undefined`.

5. **`MuaddibConfigBackedAuthBridge`** — `resolveSync` and `resolveAsync` are nearly identical (the only difference is `await`). Consider a single implementation that always returns a Promise, since the sync path is only used as an AuthStorage fallback resolver. If the sync path is strictly required by the interface, at least extract the shared cache-check + normalize logic.

6. **`hasImageToolOutput`** — A 20-line BFS with cycle detection over tool output to find `{type: "image"}`. Tool outputs are small JSON trees with no cycles. This could be `JSON.stringify(value).includes('"type":"image"')` or a simple recursive function without the `Set<unknown>` cycle guard. Over-engineered.

7. **`applySystemPromptOverrideToSession`** — Monkey-patches private fields. This is a ticking time bomb. Document the risk prominently or find an alternative.

8. **`resolveVisionFallbackModel`** — 12 lines that could be 3: resolve the model, return null if same as primary. The `.trim()` on `visionFallbackModel` is unnecessary if config validation ensures non-empty strings.

9. **`renderMessageForDebug` + `renderContentForDebug`** — ~50 lines of debug rendering that manually destructures every possible content block type. This is only used for `logger.debug`. Consider just using `JSON.stringify` with a truncation wrapper — the structured rendering adds complexity but little value for debug logs.

10. **`summarizeToolPayload`** — 15 lines to extract text from tool payloads for logging. Used in two places in the subscribe callback. The special-case for arrays-of-text-blocks could just fall through to `safeJson`.

11. **`stringifyError`** — 4-line function used once. Inline it.

12. **`SessionRunner` class** — stores every option as a separate field (10 fields). Just store `private readonly options: SessionRunnerOptions` and access `this.options.model` etc. The constructor has 70 lines of boilerplate field assignment.

13. **`SessionRunner.prompt` resolves the model twice** — once via `createAgentSessionForInvocation` (which calls `modelAdapter.resolve`), then again via `this.modelAdapter.resolve(this.model)` to get `primaryProvider`. Pass the resolved model through instead.

14. **`CreateAgentSessionInput` vs `SessionRunnerOptions`** — These interfaces share ~8 fields. `SessionRunner` manually maps its options to `CreateAgentSessionInput`. Consider having `SessionRunner` just pass through its options directly.

15. **`resourceLoader` stub in `createAgentSessionForInvocation`** — 10 lines of `() => empty` stubs. Fine, but could be a shared constant since it never changes.

---

## src/agent/tools/

### (a) Standards to formalize

1. **`toConfiguredString` is defined identically in 4 separate files** (`chronicle.ts`, `image.ts`, `oracle.ts`, `quest.ts`). **Standard: shared tiny helpers must live in one place, not be copy-pasted.**

2. **`extractFilenameFromUrl` / `extractLocalArtifactPath` / `extractFilenameFromQuery` are duplicated** between `artifact.ts`, `execute-code.ts`, and `web.ts` with near-identical implementations. **Standard: URL/artifact path utilities must be shared, not reimplemented per tool.**

3. **`looksLikeImageUrl` is duplicated** between `artifact.ts` and `web.ts`. Same function, same regex.

4. **`toErrorMessage` in `artifact.ts`** is identical to `stringifyError` in `session-runner.ts`. Pick one name, one location.

5. **Tool executor pattern is consistent and good.** The `createXxxTool(executors) → MuaddibTool` + `createDefaultXxxExecutor(options) → Executor` separation is clean and testable. Formalize this as the standard tool pattern.

### (b) Concrete cleanup opportunities

1. **`toConfiguredString` × 4** — Extract to `types.ts` or a shared utils module. It's 5 lines, defined 4 times.

2. **`extractFilenameFromUrl` × 2, `extractLocalArtifactPath` × 2, `extractFilenameFromQuery` × 2** — The versions in `artifact.ts` and `web.ts` are nearly identical (artifact.ts returns `string | undefined`, web.ts returns `string | null`). The version in `execute-code.ts` is a third implementation. Consolidate into one shared module (e.g., `artifact-storage.ts` or a new `url-utils.ts`).

3. **`looksLikeImageUrl` × 2** — Same regex in `artifact.ts` and `web.ts`. Move to shared location.

4. **`baseline-tools.ts` tool group constants are over-abstracted.** `WEB_TOOL_GROUP`, `EXECUTE_CODE_TOOL_GROUP`, `ARTIFACT_TOOL_GROUP`, `IMAGE_TOOL_GROUP`, `ORACLE_TOOL_GROUP`, `CHRONICLE_TOOL_GROUP` — each is a `ReadonlyArray<ExecutorBackedToolFactory>` containing 1-2 entries, used only in `BASELINE_EXECUTOR_TOOL_GROUPS`. The grouping adds no value — it's not used for conditional inclusion or feature flags. Just have a flat array of all tool factories.

5. **`createBaselineAgentTools` manual executor merging** — 12 lines of `options.executors?.xxx ?? defaultExecutors.xxx` for every executor. Use a spread: `const executors = { ...defaultExecutors, ...options.executors }` (filtering out undefined values).

6. **`BaselineToolExecutors` interface + `createDefaultToolExecutors`** — The interface exists to allow test injection of individual executors, which is good. But `createDefaultToolExecutors` always creates ALL executors even when only some are overridden. Since executors are cheap closures this is fine, but the 12-field manual merge in `createBaselineAgentTools` is the real problem (see above).

7. **`artifact-storage.ts` `writeArtifactText` and `writeArtifactBytes`** — These two functions are nearly identical (only difference: text uses `utf-8` encoding, bytes don't). Refactor to a single `writeArtifact(options, data: string | Buffer, suffix)`.

8. **`ensureArtifactsDirectory`** — Reads and compares the entire `index.html` on every artifact write to check if it needs updating. This is wasteful. Use a module-level flag `let indexWritten = false` or just always overwrite (it's a small file).

9. **`execute-code.ts` module-level mutable state** — `spriteCache` and `spriteCacheLocks` are module-level `Map`s. This makes testing fragile and prevents concurrent test isolation. The `resetSpriteCache` export is a testing smell. Consider injecting the cache via `ToolContext` or making the executor own its state.

10. **`execute-code.ts` dynamic imports** — `import("@fly/sprites")` and `import("./web.js")` are done dynamically inside functions, presumably to avoid loading them when sprites aren't configured. This is reasonable but should be documented. The `ExecError` import inside `spriteExec` is called on every execution — import it once at the top of the executor closure.

11. **`image.ts` — `resolveProviderApiKey` is a 5-line wrapper around `options.getApiKey`** used only by `resolveOpenRouterApiKey`. Inline it.

12. **`image.ts` — `parseJsonResponseBody`** silently wraps unparseable JSON in `{ raw: body }` instead of throwing. If the OpenRouter API returns non-JSON, that's an error, not a value.

13. **`image.ts` — `extractGeneratedImageDataUrls`** — 40 lines of defensive untyped object traversal. Define a response type and validate against it, or use a simpler approach.

14. **`oracle.ts` catches errors and returns them as strings** (`return "Oracle error: ..."`) instead of propagating. This hides failures from the caller. The iteration-limit case is somewhat reasonable, but generic errors should propagate.

15. **`quest.ts` — all three default executors return `DEFERRED_QUEST_TOOL_MESSAGE`** (a static string). These are stub implementations that validate input then always return "REJECTED: deferred". Document prominently or throw "not implemented".

16. **`web.ts` — `RateLimiter` class** — 20 lines for a simple "ensure N ms between calls" pattern. Could be a 5-line function. The `reset()` method exists only for tests (same smell as `resetSpriteCache`).

17. **`web.ts` — `buildVisitHeaders` / `resolveHttpHeadersExact` / `resolveHttpHeaderPrefixes`** — 50 lines of header resolution from `secrets`. Domain logic embedded in the web tool. Extract to config layer or a separate module.

18. **`control.ts`** — Clean and simple. No issues.

---

## src/rooms/command/

### (a) Standards to formalize

1. **Custom logger interfaces duplicated per file.** `ModeClassifierLogger`, `ContextReducerLogger`, `ToolSummaryLogger`, `CommandExecutorLogger` are all identical `{ debug, info, warn, error }` interfaces defined independently. **Standard: define one `Logger` interface (or use the one from the logging module) and import it everywhere.**

2. **Response text extraction pattern copy-pasted.** The pattern `response.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim()` appears in `classifier.ts`, `context-reducer.ts`, `proactive.ts`, and `tool-summary.ts`. **Standard: extract a `extractTextFromResponse` utility and use it everywhere.**

3. **`extractCurrentMessage` is duplicated** — defined in both `classifier.ts` and `proactive.ts` with slightly different regexes (`/<[^>]+>\s*(.*)$/` vs `/<?\S+>\s*(.*)/`). **Standard: one function, one location.**

4. **Noop logger factories duplicated.** `noopModeClassifierLogger()` in `classifier.ts`, inline `{ debug(){}, info(){}, warn(){}, error(){} }` in `proactive.ts`. **Standard: one shared noop logger.**

### (b) Concrete cleanup opportunities

1. **`config.ts`** — Single re-export line: `export { deepMergeConfig } from "../../config/muaddib-config.js"`. **Delete this file.** Consumers should import directly from the source. A re-export barrel for a single symbol is pure indirection.

2. **`classifier.ts` — `countOccurrences` + fuzzy label matching** — The classifier response parsing (count occurrences of each label in the LLM response, pick the one with the most hits) is fragile. A label like "CHAT" will match inside "CHATTY" or any word containing it. The `countOccurrences` function is 10 lines for what `String.split(token).length - 1` does. Consider exact word boundary matching or just `response.trim() === label` (since the prompt says "return exactly one token").

3. **`classifier.ts` — `createModeClassifier` returns a closure** instead of a class or just being a standalone async function. The closure captures `commandConfig` and `options` — this is just a class with extra steps. Since `CommandExecutor` already stores the result as `this.classifyMode`, the closure adds indirection for no benefit. Simplify: make it a method on `CommandExecutor` or a plain async function that takes its dependencies as arguments.

4. **`command-executor.ts` — God object.** `CommandExecutor` is ~450 lines, mixes: command resolution, context building, agent invocation, response cleaning, artifact creation, cost tracking, persistence, tool selection, system prompt building. Several of these (cost followups, response length policy, system prompt building) could be standalone functions rather than methods that only use `this` for config access.

5. **`command-executor.ts` — `numberWithDefault`** — silent defensive normalization. `numberWithDefault(this.commandConfig.rate_limit, 30)` silently falls back to 30 if config has `"rate_limit": "banana"`. Should throw on bad config, not silently fix it. Same pattern as Phase 1 findings.

6. **`command-executor.ts` — `normalizeThinkingLevel`** — silently maps unknown strings to `"minimal"`. Should throw on invalid `reasoningEffort` values from config. The valid values are known and finite.

7. **`command-executor.ts` — `trimToMaxBytes`** — O(n²) algorithm. Removes one character at a time, recalculating `Buffer.byteLength` each iteration. Use `Buffer.from(text).subarray(0, maxBytes).toString()` (with boundary fixup) or binary search.

8. **`command-executor.ts` — `LEADING_IRC_CONTEXT_ECHO_PREFIX_RE`** — 150-char regex with no explanation. Needs a comment explaining what it matches and why, with examples. The `stripLeadingIrcContextEchoPrefixes` function should have a docstring.

9. **`command-executor.ts` — `sleep`** — trivial utility (`new Promise(resolve => setTimeout(resolve, ms))`). Used once. Inline it or import from a shared utils module.

10. **`command-executor.ts` — `formatCurrentTime`** — hand-rolled date formatting. Use `Intl.DateTimeFormat` or just `date.toISOString().slice(0, 16).replace("T", " ")`. The manual zero-padding is 6 lines of boilerplate.

11. **`command-executor.ts` — `EMPTY_RESOLVED`** — module-level mutable constant (it's an object, so technically mutable). Should be `Object.freeze()`d or inlined at usage sites. Also, `deliverResult` is called with partial `EMPTY_RESOLVED` for error paths — consider a helper `errorResult(message, text)` to reduce the 5-line boilerplate repeated 3 times.

12. **`command-executor.ts` — `isRateLimitedResult`** — private method, never called anywhere. **Dead code, delete it.**

13. **`command-executor.ts` — `buildToolOptions`** — called twice (constructor + `selectTools`). The constructor call is only to get `shareArtifact`. Consider lazy-initializing `shareArtifact` instead of constructing full tool executors in the constructor.

14. **`context-reducer.ts` — silent error swallowing.** The `catch` block in `reduce()` silently returns the unreduced context on any error. At minimum, log the error. This hides LLM failures, auth issues, network errors.

15. **`context-reducer.ts` — `options` stored redundantly.** The constructor stores `this.options` (for `options.logger`) but also destructures `this.config` and `this.modelAdapter` from it. Just store the individual fields.

16. **`resolver.ts` — `runtimeForTrigger` returns a tuple** `[string, RuntimeSettings]` — should return a named object `{ modeKey, runtime }` for readability. Every call site immediately destructures `const [modeKey, runtime] = ...`.

17. **`resolver.ts` — `resolve()` has massive duplication.** The four return paths for error/help/explicit/automatic all construct a full `ResolvedCommand` object with many identical fields. Extract a builder or use `{ ...defaults, ...overrides }` pattern.

18. **`steering-queue.ts` — `QueuedInboundMessage` constructor Promise pattern** — The `resolve ?? (() => {})` fallback is dead code; the Promise executor runs synchronously, so `resolve` and `reject` are always assigned before the fallback is evaluated. Remove the fallback.

19. **`proactive.ts` — `buildProactiveConfig` defensive defaults.** `debounce_seconds: rawProactive.debounce_seconds ?? 15` — if the field is present but wrong type (e.g., a string), this silently uses the string. No validation. Same pattern as config phase findings.

20. **`tool-summary.ts` — `formatToolSummaryLogPreview`** — another `truncateForDebug` variant (collapse whitespace, truncate, append "..."). This is the 3rd+ copy of this pattern across the codebase. **Deduplicate.**

21. **`tool-summary.ts` — `renderPersistenceValue`** — 7-line function that's just `typeof x === 'string' ? x : JSON.stringify(x, null, 2)`. Used once. Inline it.

22. **`message-handler.ts`** — Relatively clean orchestrator. The `handlePassiveMessage` has an unused empty line before the closing brace. Minor: the re-exports at the top could be trimmed if consumers imported directly from `command-executor.ts`.

---

## src/rooms/ (top-level) + src/rooms/irc/ + src/rooms/discord/ + src/rooms/slack/

### (a) Coding standards to formalize

1. **Shared utility functions must not be copy-pasted across files.** The following are duplicated verbatim across 3+ room files and should live in a single shared module:
   - `escapeRegExp` — identical in irc/monitor.ts, discord/monitor.ts, slack/monitor.ts, slack/transport.ts (4 copies)
   - `sleep` — identical in irc/monitor.ts, discord/monitor.ts, slack/monitor.ts, send-retry.ts (4 copies)
   - `requireNonEmptyString` — identical in irc/monitor.ts, discord/monitor.ts, slack/monitor.ts (3 copies)
   - `normalizeName` — identical in discord/transport.ts, slack/transport.ts, slack/monitor.ts (3 copies)
   - `nowMonotonicSeconds` — identical in discord/monitor.ts, slack/monitor.ts (2 copies)
   - `resolveReplyEditDebounceSeconds` — identical in discord/monitor.ts, slack/monitor.ts (2 copies)
   - `resolveReconnectPolicy` — identical in discord/monitor.ts, slack/monitor.ts (2 copies)
   - `appendAttachmentBlock` — identical in discord/monitor.ts, slack/monitor.ts (2 copies)

2. **`AsyncQueue<T>` is implemented 3 times** — in varlink.ts, discord/transport.ts, slack/transport.ts. Identical class each time. Extract to shared utility.

3. **Logger interface duplication continues.** `AutoChroniclerLogger` in autochronicler.ts is yet another copy of the same `{ debug, info, warn, error }` interface. Combined with previous phases, this is now 6+ independent definitions of the same interface.

4. **Transport signal pattern is duplicated.** `DiscordTransportSignal` / `isDiscordTransportSignal` and `SlackTransportSignal` / `isSlackTransportSignal` are structurally identical — a `{ kind: "disconnect"; reason: string }` type with a type guard. Could be a shared `TransportDisconnectSignal`.

5. **`CommandLike` interface defined independently in both discord/monitor.ts and slack/monitor.ts and irc/monitor.ts** — three identical copies. Should be a shared type.

### (b) Concrete cleanup opportunities

#### `src/rooms/message.ts`
1. Clean and minimal. No issues.

#### `src/rooms/send-retry.ts`
2. **`normalizeMaxAttempts`** — defensive normalization. If someone passes a non-number `maxAttempts`, that's a bug. Should throw or at minimum use a simple `?? DEFAULT_MAX_ATTEMPTS` instead of `Number.isFinite` + `>= 1` + `Math.floor` dance.
3. **`extractRetryAfterMs`** — 60 lines of ultra-defensive error shape sniffing. Checks `.retryAfterMs`, `.retry_after_ms`, `.retry_after`, `Retry-After` header, `.code`, `.status`, `.statusCode` — massive surface area. Most of this is speculative; Discord and Slack SDKs have known error shapes. This should be platform-specific extraction, not a universal guessing function.
4. **`retryAfterHeaderSeconds`** — handles `Headers` instance, plain object, and array-of-strings. Speculative generality — do Discord.js or Slack Bolt actually expose any of these? If not, dead code.
5. **`numberValue`** — yet another "parse a number from unknown" helper. Same pattern as `normalizePositiveInteger` etc from Phase 1.
6. **`isRecord`** — duplicated here; also exists in slack/transport.ts as `asRecord`. Same concept, different API.
7. **`summarizeRetryError`** — yet another `stringifyError` / `toErrorMessage` variant. Now at 4+ implementations across the codebase.
8. **`sleep`** — one of 4 copies.

#### `src/rooms/autochronicler.ts`
9. **`AutoChroniclerLogger`** — yet another copy of the logger interface.
10. **`DEFAULT_LOGGER`** — yet another noop/console logger factory. Same as in multiple other files.
11. **`withArcLock`** — custom promise-based mutex. Same concept as `PromiseMutex` in varlink.ts. Two different mutex implementations in the same codebase. The autochronicler version is more complex (tracks per-arc queues) but the core locking primitive is the same.
12. **Response text extraction** — `response.content.filter(entry => entry.type === "text").map(entry => entry.text).join("\n").trim()` — another copy of the pattern flagged in Phase 3 (now 5+ copies).

#### `src/rooms/irc/monitor.ts`
13. **`createIrcCommandHandlerOptions`** — function that takes a `RoomMessageHandler` and returns it. Pure identity function, completely useless. Dead code.
14. **`defaultResponseCleaner`** — `text.replace(/\n/g, "; ").trim()` then `return cleaned || text`. The fallback `|| text` is defensive nonsense — if `trim()` returns empty, the original was whitespace-only, returning it unchanged is wrong. And the same lambda is already defined inline in `fromRuntime`. So this default is both buggy and redundant.
15. **`sleep`** — copy #2.
16. **`escapeRegExp`** — copy #1.
17. **`requireNonEmptyString`** — copy #1.

#### `src/rooms/irc/varlink.ts`
18. **`AsyncQueue<T>`** — copy #1 of 3.
19. **`PromiseMutex`** — similar to `withArcLock` in autochronicler.ts. Two mutex implementations.
20. **`trimToPayloadWithEllipsis`** — yet another truncation helper. Same pattern as `truncateForDebug` / `formatToolSummaryLogPreview` from Phase 3. Now 4+ truncation implementations.
21. **`splitMessageForIrcPayload`** — 80+ lines of elaborate split-point scoring with priority levels, candidate lists, cumulative byte arrays. Overcomplicated for splitting IRC messages. The entire candidate/scoring system could be simplified to: find the best break point by iterating backwards from maxPayload looking for sentence-end > semicolon > comma > space.
22. **`expandHomePath`** — trivial `~` expansion. Node's standard approach would be to use the config layer to resolve paths before they reach transport code. This is the only place it's used.
23. **`calculateIrcMaxPayload`** — exported but only used internally by `VarlinkSender.sendMessage`. Could be private/unexported unless tests need it.

#### `src/rooms/discord/monitor.ts`
24. **`normalizeContent`** duplicated — identical function in discord/monitor.ts and discord/transport.ts (both strip custom emoji markup). Two copies in the same room.
25. **`escapeRegExp`** — copy #2.
26. **`sleep`** — copy #3.
27. **`requireNonEmptyString`** — copy #2.
28. **`resolveReconnectPolicy`** — copy #1 of 2 (identical to slack's).
29. **`resolveReplyEditDebounceSeconds`** — copy #1 of 2.
30. **`nowMonotonicSeconds`** — copy #1 of 2.
31. **`sendWithDiscordRetryResult`** — identical structure to `sendWithSlackRetryResult` in slack/monitor.ts. Only difference is `platform: "discord"` vs `platform: "slack"`. Should be a generic `sendWithRetryResult` parameterized by platform.
32. **`normalizeDirectContent`** in discord vs slack — very similar but subtly different (discord has an extra `anyMentionPattern` fallback). Should be consolidated or the difference made explicit.
33. **Reply-edit debounce logic** — the entire pattern of `lastReplyMessageId` / `lastReplyText` / `lastReplyAtSeconds` / edit-vs-send decision is duplicated between Discord and Slack monitors (~40 lines each). Should be extracted into a shared `ReplyEditAccumulator` or similar.
34. **`buildDiscordAttachmentBlock`** vs **`buildSlackAttachmentBlock`** — nearly identical. Both format `[Attachments]...[/Attachments]` blocks. Could share a generic builder with platform-specific field mapping.

#### `src/rooms/discord/transport.ts`
35. **`AsyncQueue<T>`** — copy #2 of 3.
36. **`normalizeDiscordContent`** — duplicate of `normalizeContent` in discord/monitor.ts.
37. **Channel name resolution logic** — duplicated between `mapMessage` and `mapMessageEdit` (same if/else chain for DM vs thread vs regular channel). Extract to a shared method.

#### `src/rooms/slack/monitor.ts`
38. **`escapeRegExp`** — copy #3.
39. **`sleep`** — copy #4.
40. **`requireNonEmptyString`** — copy #3.
41. **`resolveReconnectPolicy`** — copy #2, identical to discord's.
42. **`resolveReplyEditDebounceSeconds`** — copy #2.
43. **`nowMonotonicSeconds`** — copy #2.
44. **`sendWithSlackRetryResult`** — identical to discord's `sendWithDiscordRetryResult` except platform string.
45. **`normalizeName`** — copy shared with discord/transport.ts and slack/transport.ts.
46. **`appendAttachmentBlock`** — copy #2, identical to discord's.
47. **`run()` method** — the entire reconnect loop in `SlackRoomMonitor.run()` is structurally identical to `DiscordRoomMonitor.run()`. Same connect/disconnect tracking, same reconnect counter, same finally block. ~60 lines of duplicated control flow. Should be a shared `monitorRunLoop` or base class.

#### `src/rooms/slack/transport.ts`
48. **`AsyncQueue<T>`** — copy #3 of 3.
49. **`stringifyError`** — yet another error-to-string helper. Different name from `toErrorMessage`, `summarizeRetryError`, etc.
50. **`escapeRegExp`** — copy #4.
51. **`normalizeName`** — copy #2.
52. **`asRecord`** — same concept as `isRecord` in send-retry.ts but returns `T | null` instead of being a type guard. Pick one API.
53. **`TYPING_LOADING_MESSAGES`** — hardcoded Dune-themed loading messages. Fine, but should probably be in config if the bot identity is configurable.
54. **Channel name resolution** — duplicated between `mapMessage` and `mapMessageEdit` (same im-check + getChannelName pattern). Extract to shared method within the class.

### Summary of cross-cutting duplication in this phase

| Function | Copies | Files |
|----------|--------|-------|
| `escapeRegExp` | 4 | irc/monitor, discord/monitor, slack/monitor, slack/transport |
| `sleep` | 4 | irc/monitor, discord/monitor, slack/monitor, send-retry |
| `AsyncQueue<T>` | 3 | varlink, discord/transport, slack/transport |
| `requireNonEmptyString` | 3 | irc/monitor, discord/monitor, slack/monitor |
| `normalizeName` | 3 | discord/transport, slack/transport, slack/monitor |
| `resolveReconnectPolicy` | 2 | discord/monitor, slack/monitor |
| `resolveReplyEditDebounceSeconds` | 2 | discord/monitor, slack/monitor |
| `nowMonotonicSeconds` | 2 | discord/monitor, slack/monitor |
| `appendAttachmentBlock` | 2 | discord/monitor, slack/monitor |
| `sendWith*RetryResult` | 2 | discord/monitor, slack/monitor |
| `normalizeContent` / `normalizeDiscordContent` | 2 | discord/monitor, discord/transport |
| `run()` reconnect loop | 2 | discord/monitor, slack/monitor |
| Reply-edit debounce logic | 2 | discord/monitor, slack/monitor |

The Discord and Slack monitors are ~70% identical code. The most impactful cleanup would be extracting a shared `PlatformRoomMonitor` base or a `monitorRunLoop` + `ReplyAccumulator` composition that both use, plus a `src/rooms/shared.ts` for all the duplicated utility functions.

---

## src/app/ + src/cli/ + src/runtime.ts

### src/app/logging.ts

**What it is**: Defines `RuntimeLogger` interface, `RuntimeLogWriter` (structured file+stdout logger with `AsyncLocalStorage`-based per-message log routing), `createConsoleLogger` (lightweight fallback), and helpers.

**(a) Standards**:
- `RuntimeLogger` is the canonical logger interface. It has `debug/info/warn/error/child/withMessageContext`. Good.
- `createConsoleLogger` returns a `RuntimeLogger`-shaped object as a fallback for when no `RuntimeLogWriter` is available.

**(b) Cleanup**:

1. **12 redundant logger interfaces across the codebase**: `ModeClassifierLogger`, `ContextReducerLogger`, `ToolSummaryLogger`, `CommandExecutorLogger`, `AutoChroniclerLogger`, `SendRetryLogger`, `DeferredFeatureLogger`, `LlmTraceLogger`, `ChronicleLogger`, `QuestRuntimeLogger`, `RunnerLogger`, `ToolExecutorLogger` — all subsets of `{ debug, info, warn, error }`. Every single one could just use `RuntimeLogger` (or a `Pick<RuntimeLogger, 'debug' | 'info' | ...>` if you really want narrow coupling). This is the single biggest interface duplication in the codebase. **Fix**: Use `RuntimeLogger` everywhere, or define one narrow `SimpleLogger = Pick<RuntimeLogger, 'info' | 'warn' | 'error'>` type next to `RuntimeLogger` and use that.

2. **`createConsoleLogger` fallback pattern**: Every room monitor does `this.logger = options.logger ?? createConsoleLogger(...)`. The logger is always provided via `fromRuntime`, so the fallback only exists for standalone construction in tests. This is fine but could be simplified — the monitors could just require a logger (no optional, no fallback).

3. **`withMessageContext` on the interface**: Every logger implementation (including `createConsoleLogger`'s inline object) must implement this method, but only `RuntimeLogWriter` actually uses `AsyncLocalStorage`. The console logger's implementation is a no-op passthrough. This is a leaky abstraction — `withMessageContext` is a concern of the log *writer*, not the logger interface. It's only called in 2 places (cli/message-mode.ts and the room monitors). **Fix**: Remove `withMessageContext` from `RuntimeLogger` interface. Call it directly on `RuntimeLogWriter` where needed.

4. **Synchronous `appendFileSync` + `mkdirSync` in hot path**: `write()` does sync I/O on every log line. Fine for low-volume bot, but worth noting.

### src/app/main.ts

**What it is**: Entry point for the main service. Parses `--config`, creates runtime, launches room monitors.

**(b) Cleanup**:

1. **`RunnableMonitor` interface**: Defines `{ run(): Promise<void> }` locally. Used only in this file, for a single array. Unnecessary — just use the concrete types or inline.

2. **`isExecutedAsMain()`**: 4-line function used once, at module top-level. Inline it.

3. **`import { pathToFileURL } from "node:url"`**: Only used by `isExecutedAsMain`.

4. **`parseAppArgs`**: Hand-rolled arg parser. Fine for 1 flag, but `src/cli/main.ts` has another hand-rolled parser. Neither is complex enough to extract, but worth noting the pattern.

### src/cli/main.ts

**What it is**: CLI entry point for `--message` mode.

**(b) Cleanup**:

1. **`parseArgs` is another hand-rolled arg parser** — same pattern as `parseAppArgs` in `src/app/main.ts`. Minor duplication but not worth unifying for 2 uses.

2. **Clean and simple**. No significant issues.

### src/cli/message-mode.ts

**What it is**: Core CLI message-mode logic. Creates runtime, constructs `RoomMessageHandler`, sends a single message, returns result.

**(b) Cleanup**:

1. **Creates its own `RuntimeLogWriter`** then also gets one from `createMuaddibRuntime` (which accepts `logger` option). This is fine — it passes its logger in. No issue.

2. **Hardcoded defaults**: `serverTag: "testserver"`, `channelName: "#testchannel"`, `nick: "testuser"`, `mynick: "testbot"`. These are only for CLI testing, so fine, but they're named `test*` which is misleading for a production CLI tool.

3. **`arc` construction**: `${message.serverTag}#${message.channelName}` — this `serverTag#channelName` pattern for arc naming is duplicated in room monitors too. Should be a shared utility.

### src/runtime.ts

**What it is**: `MuaddibRuntime` interface + factory function + shutdown. Central god-object that holds config, history, model adapter, chronicle subsystem, logger.

**(b) Cleanup**:

1. **`MuaddibRuntime` is a grab-bag god-object**: It holds 8 fields, 3 of which are optional (`chronicleStore`, `chronicleLifecycle`, `autoChronicler`). Every consumer imports it but uses only 2-3 fields. This is the classic "pass the world" anti-pattern. The AGENTS.md says "Loose Coupling: config values should be resolved and validated at the point of use, not threaded through intermediary structures." `MuaddibRuntime` violates this principle — it exists primarily to thread values through `fromRuntime` static methods.

2. **`getApiKey` is a thin closure over `staticKeys`**: It's `(provider: string) => staticKeys[provider]`. This is on the `MuaddibRuntime` interface as a first-class field, but it's just a dictionary lookup. Could be `apiKeys: Record<string, string>` instead of a function. The function form suggests it might become async (the type allows `Promise<string | undefined>`), but currently it never is.

3. **`defaultHistorySize` derived from `getRoomConfig("irc")`**: Hardcodes "irc" as the default room for history size. If no IRC room is configured, this silently uses whatever fallback `getRoomConfig` returns. Fragile.

4. **Chronicle initialization is ~30 lines of conditional setup** inside the factory. This could be extracted to a `createChronicleSubsystem(config, modelAdapter, logger, muaddibHome)` function for clarity.

5. **`shutdownRuntime`** is a standalone function rather than a method — fine for the functional style, but it only closes history and chronicle store. If more cleanup is added later, this becomes a maintenance risk.

### Cross-cutting: Logger interface duplication (the biggest issue)

The codebase has **12 independent logger interface definitions** that are all subsets of `RuntimeLogger`:

| Interface | File | Methods |
|-----------|------|---------|
| `RuntimeLogger` | app/logging.ts | debug, info, warn, error, child, withMessageContext |
| `RunnerLogger` | agent/session-factory.ts | debug, info, warn, error |
| `ToolExecutorLogger` | agent/tools/types.ts | debug, info, warn, error |
| `ModeClassifierLogger` | rooms/command/classifier.ts | debug, info, warn, error |
| `ContextReducerLogger` | rooms/command/context-reducer.ts | debug, info, warn, error |
| `ToolSummaryLogger` | rooms/command/tool-summary.ts | info |
| `CommandExecutorLogger` | rooms/command/command-executor.ts | debug, info, warn, error |
| `AutoChroniclerLogger` | rooms/autochronicler.ts | debug, info, warn, error |
| `SendRetryLogger` | rooms/send-retry.ts | debug, info, warn, error |
| `DeferredFeatureLogger` | config/deferred-features.ts | warn |
| `LlmTraceLogger` | models/pi-ai-model-adapter.ts | debug, info |
| `ChronicleLogger` | chronicle/lifecycle.ts | debug, info, warn, error |
| `QuestRuntimeLogger` | chronicle/quest-runtime.ts | debug, info, warn, error |

**Fix**: Define `SimpleLogger = Pick<RuntimeLogger, 'debug' | 'info' | 'warn' | 'error'>` in `app/logging.ts` and use it everywhere. Delete all 12 local interfaces. For the narrow ones (`ToolSummaryLogger` with just `info`, `DeferredFeatureLogger` with just `warn`), use `Pick<SimpleLogger, 'info'>` or just accept `SimpleLogger`.


---

## src/chronicle/ + src/history/

### src/chronicle/chronicle-store.ts

#### (a) Standards

1. **Row-to-model mapping is repeated inline everywhere.** Every method that reads a `Chapter` manually maps `row.arc_id → arcId`, `row.opened_at → openedAt`, etc. This 6-line mapping block appears in `getOpenChapter`, `openNewChapter`, `resolveChapter` (twice), and `resolveChapterRelative`. **Standard: define a single `toChapter(row)` mapper function and call it everywhere.**

2. **`requireDb()` pattern is fine.** Both stores use it identically — acceptable.

#### (b) Cleanup

1. **`renderChapter` and `renderChapterRelative` are ~80% identical.** Both query paragraphs, slice by `lastN`, build a title string, and format lines. They differ only in how the title is constructed. Extract a shared `formatChapterParagraphs(chapter, rows, lastN, titleExtra)` helper. ~40 lines removable.

2. **`resolveChapterRelative` fetches ALL chapters for the arc** then does array index arithmetic in JS. This could be a single SQL query with `LIMIT 1 OFFSET`. The current approach is O(n) in chapters per arc for every call.

3. **Column migration for `resume_at`** in `initialize()` uses a runtime `PRAGMA table_info` check. This is fine for now but the chat history store does the same pattern — both should ideally share a `migrateAddColumn(db, table, column, type)` utility.

4. **`Number(result.lastID ?? 0)`** appears 3 times. If `lastID` is somehow null/undefined, silently using 0 as an ID is wrong — it should throw. This is the "defensive normalization hiding bugs" pattern.

5. **`getOrOpenCurrentChapter` calls `getOrCreateArc` then `getOpenChapter` then maybe `openNewChapter`.** But `appendParagraph` also calls `getOrOpenCurrentChapter`, meaning every paragraph append does 2-3 queries just for chapter resolution. Not a correctness issue but worth noting.

### src/chronicle/lifecycle.ts

#### (a) Standards

1. **`ChronicleLogger` is another duplicate logger interface** (debug + error). Already catalogued — should be `Pick<RuntimeLogger, 'debug' | 'error'>` or the unified `SimpleLogger`.

2. **`ChronicleQuestRuntimeHook` interface is defined locally** rather than imported from quest-runtime.ts. The quest runtime's `onChronicleAppend` method signature is the implementation. This is an acceptable structural typing pattern in TS but worth noting — if the signatures ever drift, there's no compile-time link.

#### (b) Cleanup

1. **Response text extraction pattern** in `generateChapterSummary`: `response.content.filter(e => e.type === "text").map(e => e.text).join("\n").trim()` — this is the 6th+ copy of this pattern across the codebase. Extract to a shared `extractResponseText(response)` utility.

2. **`resolveParagraphLimit` does silent defensive normalization.** If `paragraphs_per_chapter` is negative or non-finite, it silently falls back to `DEFAULT_PARAGRAPHS_PER_CHAPTER`. This should throw — a negative paragraph limit is a config error, not something to silently fix.

3. **`withArcLock` is a custom per-arc serial queue.** It's a 4th implementation of the `AsyncQueue` pattern found elsewhere. However, this one is slightly different (keyed by arc string, promise-chain based rather than array-based). Still, the proliferation of ad-hoc concurrency primitives is a smell.

4. **`collectUnresolvedQuestParagraphs` does regex parsing of paragraph text** to find `<quest>` and `<quest_finished>` tags. The same regexes (`QUEST_OPEN_RE`, `QUEST_FINISHED_RE`) are defined in quest-runtime.ts. These should be shared constants.

5. **Optional `logger` field** — when not provided, chronicle lifecycle silently swallows all logging. If the caller forgot to pass a logger, they get no diagnostics. Should require a logger.

### src/chronicle/quest-runtime.ts

#### (a) Standards

1. **`QuestRuntimeLogger`** — yet another 4-method logger interface (debug/info/warn/error). Duplicate #12. Kill it.

2. **`DEFAULT_LOGGER`** is a console-forwarding logger factory defined inline — another instance of the duplicated noop/console logger pattern found in 4+ files.

#### (b) Cleanup

1. **`sleep` is defined locally at the bottom of the file.** This is the 5th+ copy. Extract to a shared `src/utils/sleep.ts`.

2. **`resolveCooldownSeconds` does defensive normalization** — non-finite or ≤0 silently becomes 60. A bad cooldown value should throw at construction time.

3. **`isArcAllowed` returns `true` when `allowedArcs` is empty** — "empty allowlist means allow everything" is a counter-intuitive convention. It means if you forget to configure arcs, quests run on all arcs silently. Should require explicit configuration or at least log a warning.

4. **`parseQuestParagraph` and the two regexes** (`QUEST_OPEN_RE`, `QUEST_FINISHED_RE`) are duplicated from lifecycle.ts logic. Share them.

5. **`heartbeatLoop` sleeps first, then ticks.** This means on startup, quests wait a full cooldown period before the first check. Might be intentional but worth documenting.

### src/history/chat-history-store.ts

#### (a) Standards

1. **Inline migration pattern** (`migrateChatMessagesTable`, `migrateLlmCallsTable`) uses `PRAGMA table_info` to check for columns and adds them if missing. This is the same pattern as chronicle-store.ts. **Standard: if both stores use the same migration approach, extract a shared `ensureColumn(db, table, column, type)` helper.**

2. **Content template system** (`"<{nick}> {message}"`) is a simple string replace with no escaping. If a nick contains `{message}`, it'll be double-replaced. Low risk but fragile.

#### (b) Cleanup

1. **`getContext` has 3 SQL query branches** for thread handling (with threadStarterId, with threadId only, without threadId). The queries are nearly identical — they differ only in the WHERE clause. Extract the shared parts.

2. **`getFullHistory` has two nearly identical queries** differing only by `LIMIT ?`. Use a single query with conditional parameter.

3. **`getLlmCalls` same pattern** — two identical queries differing only by LIMIT. Same fix.

4. **`getRecentMessagesSince` does post-query parsing** of the `"> "` content format to extract the message portion. This is fragile — it depends on the `<{nick}> {message}` template format. If the template changes, this silently returns empty arrays (via `flatMap` returning `[]`). This coupling between storage format and retrieval logic should be explicit.

5. **`modeToPrefix` checks `if (!mode)` after already receiving a `string` parameter** — the caller already checked for mode existence. Redundant guard.

6. **`defaultRoleForMessage` does case-insensitive nick comparison** using `toLowerCase()`. This is fine but the same pattern appears in room monitors. Could be a shared utility but low priority.

7. **`countRecentUnchronicled`** — the `days` parameter uses string interpolation in SQL (`'-' || ? || ' days'`). This works but is unusual; a computed datetime string would be clearer.

---

## Summary of all phases

Top 10 highest-impact cleanup opportunities across the entire codebase, ranked by (lines removable × frequency):

### 1. **Unify 12+ duplicate logger interfaces into one**
~12 locally-defined logger interfaces, all subsets of `RuntimeLogger`. Replace with `SimpleLogger = Pick<RuntimeLogger, 'debug' | 'info' | 'warn' | 'error'>` in one place. Delete ~60 lines of interface definitions + ~30 lines of `DEFAULT_LOGGER` / noop logger factories scattered across files.

### 2. **Extract shared utilities: `sleep`, `escapeRegExp`, `requireNonEmptyString`, `toConfiguredString`, `extractResponseText`**
These are each copy-pasted 3-6 times. A single `src/utils/` module eliminates ~100+ duplicated lines and makes behavior consistent (e.g., `sleep` implementations vary slightly).

### 3. **Replace hand-rolled config parsing with schema validation (zod/typebox)**
`MuaddibConfig` is ~300 lines of manual JSON-to-typed-object mapping with silent coercion. A schema validator replaces this with ~80 lines of declarative schema + derived types, eliminates `stringOrUndefined`/`numberOrUndefined`/`asRecord` helpers, and makes config errors loud.

### 4. **Merge Discord and Slack monitors (~70% identical)**
Both follow the same architecture: connect → listen → enqueue → dequeue → handle. Extract a shared `PlatformMonitor` base or composition helper. ~300 lines removable.

### 5. **Deduplicate `AsyncQueue<T>` (3 copies)**
Three identical async queue implementations. Extract to `src/utils/async-queue.ts`. ~60 lines removable.

### 6. **Kill defensive normalization — throw on bad config instead**
`resolveParagraphLimit`, `resolveCooldownSeconds`, `resolveMaxIterations`, and ~5 other `resolve*` functions silently fix bad values. Each should throw at construction/initialization time. This doesn't remove much code but eliminates a class of silent-failure bugs.

### 7. **Deduplicate `renderChapter` / `renderChapterRelative` and similar SQL query patterns**
Both chronicle-store rendering methods and multiple chat-history query methods (getFullHistory, getLlmCalls, getContext) have near-duplicate code paths differing by one clause. ~80 lines removable.

### 8. **Eliminate error-to-string variants (`stringifyError`, `toErrorMessage`, `summarizeRetryError`, inline `instanceof Error` checks)**
4+ ways to convert errors to strings. Standardize on one `toErrorMessage(e: unknown): string` utility. ~40 lines removable.

### 9. **Break up `MuaddibRuntime` god-object**
Currently holds ~15 optional fields spanning config, rooms, chronicle, history, and model adapter. Group into sub-objects (e.g., `runtime.chronicle.{store, lifecycle, autoChronicler}`) or inject dependencies directly where needed instead of threading everything through one bag.

### 10. **Remove module-level mutable singletons with test-only reset functions**
`deferred-features.ts` and similar use module-level `let` state with `resetForTesting()`. Replace with explicit instance management — pass the state object through constructors. Eliminates the global-state footgun and the test-only API surface.
