# muaddib Agent Guide

## Build/Test Commands
- Install dependencies: `npm ci`
- Typecheck: `npm run typecheck`
- Tests: ALWAYS wrap with timeout to prevent zombie vitest workers: `timeout 30 npm test 2>&1 | tail -40` or `timeout 30 npm test 2>&1 | grep -A5 'FAIL\|Error'`
- Build runtime: `npm run build`
- Any change should be accompanied with tests update. (Always prefer updating existing unit tests over adding new ones.)
- Any change where viable should be tested by actually running the CLI e2e test: `MUADDIB_HOME=. npm run cli:message -- --message "your message here"`
- **Rely on pre-commit hooks** for typecheck/tests/lint — don't run them manually before committing unless you need to debug a specific failure. The pre-commit pipeline runs typecheck, tests, lint, and build automatically on `git commit`.
- Python runtime/tests are deprecated and auxiliary; do not use them as the primary validation path.
- You must test and commit your work once finished. Never respond with "Tests not run (not requested)."
- NEVER use `git add -A` blindly, there may be untracked files that must not be committed; use `git add -u` instead

## Architecture
- **Built on**: [`pi-coding-agent`](https://github.com/badlogic/pi-mono) SDK (`@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`). Muaddib uses the `Agent` class from pi-agent-core but overrides all built-in tools via `baseToolsOverride` — pi's default read/write/bash tools are **not** exposed to the agent. All tools (execute_code, web_search, etc.) are muaddib's own, defined in `src/agent/tools/`.
- **Main Service**: `src/app/main.ts` - core service coordinator (config, history, rooms, chronicler lifecycle)
- **CLI Message Mode**: `src/cli/main.ts` + `src/cli/message-mode.ts`
- **Room Isolation**:
  - IRC: `src/rooms/irc/monitor.ts`, `src/rooms/irc/varlink.ts`
  - Discord: `src/rooms/discord/monitor.ts`, `src/rooms/discord/transport.ts`
  - Slack: `src/rooms/slack/monitor.ts`, `src/rooms/slack/transport.ts`
- **Command Handling**: `src/rooms/command/*` (resolver, classifier, handler, rate limiter, context reduction)
- **Agent Runtime**: `src/agent/session-runner.ts` + `src/agent/session-factory.ts` + `src/agent/tools/*`
- **Persistence**:
  - Chat history: `src/history/chat-history-store.ts`
  - Chronicle: `src/chronicle/*`
- **Config & Data**: all runtime state lives under `$MUADDIB_HOME` (defaults to `~/.muaddib/`), including `config.json`, `chat_history.db`, `chronicle.db`, `artifacts/`, `logs/`
- Models MUST be fully-qualified as `provider:model` (e.g. `anthropic:claude-sonnet-4`). No defaults.
- No backwards compatibility shims for legacy config keys.
- Python code under `muaddib/` is deprecated and kept as auxiliary reference only.

## Code Style
- **Language**: TypeScript (Node 20+, ESM, strict mode)
- **Async**: async/await for non-blocking room/message flow
- **Naming**: camelCase for variables/functions, PascalCase for classes/types
- **Imports**: Node built-ins, then third-party, then local modules
- **Error Handling**: fail fast; catch only where a concrete recovery strategy exists
- **Loose Coupling**: config values should be resolved and validated at the point of use, not threaded through intermediary structures. Avoid putting fields on shared runtime objects just to pass them to a single consumer.
- **Logging**: keep stdout concise, preserve structured/runtime detail in file logs
- **Dependency Injection**: core runtime dependencies (especially `modelAdapter`/auth) must be explicitly injected and required in types; no hidden local fallback instantiation (`?? new ...`) in internal services.
- **Search before creating**: Before writing any helper function, interface, error class, or abstraction, search the codebase for existing equivalents. If found, import and reuse (narrow with `Pick<>` if needed). If the same logic already exists in another file, extract to a shared module first.
- **No silent normalization**: If a config/input value is present but has the wrong type or range, throw — don't silently coerce to a default. Use `?? default` only for genuinely absent values, never to paper over invalid ones.
- **No over-engineering for single use cases**: If a function, class, or abstraction has exactly one call site and adds no testability or clarity, inline it. This includes: single-re-export barrel files, identity wrapper functions, custom error classes with no discriminant fields, normalize wrappers that just set one default.

## Testing
- Vitest behavioral tests in `tests-ts/`
- Prefer extending existing tests instead of creating new files unless justified
- Keep room/command behavior parity covered when changing handler logic
- Tests should avoid mocking low-level API client constructors when validating control flow. Prefer patching router calls to inject fake responses, and ensure provider configs are referenced via `providers.*`.
- Do NOT introduce compatibility shims for legacy config fields; update tests and fixtures instead.
- When changing tests, prefer modifying/extending existing test files and cases rather than adding new test files, unless there is a compelling reason.

## Contributing Guideline
- All new changes follow the red-green-refactor TDD approach!
- For AI agents: When user is frustrated, stop and think: why? Consider whether not to append an additional behavioral instruction to this AGENTS.md file.
- Every time after committing your work, stop and think: how could I improve the codebase I just touched? Did I notice any case of spaghetti code, useless adapters, wrong decoupling, invalid separation of concerns? Propose concrete ideas to the user.

## Deprecated Python Runtime (auxiliary)
- Legacy invocation remains available temporarily via: `uv run muaddib`
- Keep operator docs clear that TypeScript runtime is primary
