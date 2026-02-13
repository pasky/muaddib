# muaddib Agent Guide

## Build/Test Commands
- Install dependencies: `npm ci`
- Typecheck: `npm run typecheck`
- Tests: `npm test`
- Build runtime: `npm run build`
- Any change should be accompanied with tests update. (Always prefer updating existing unit tests over adding new ones.)
- Any change where viable should be tested by actually running the CLI e2e test: `MUADDIB_HOME=. npm run cli:message -- --message "your message here"`
- Run linting/typecheck/etc. via pre-commit where configured.
- Python runtime/tests are deprecated and auxiliary; do not use them as the primary validation path.
- You must test and commit your work once finished. Never respond with "Tests not run (not requested)."
- NEVER use `git add -A` blindly, there may be untracked files that must not be committed; use `git add -u` instead

## Architecture
- **Main Service**: `src/app/main.ts` - core service coordinator (config, history, rooms, chronicler lifecycle)
- **CLI Message Mode**: `src/cli/main.ts` + `src/cli/message-mode.ts`
- **Room Isolation**:
  - IRC: `src/rooms/irc/monitor.ts`, `src/rooms/irc/varlink.ts`
  - Discord: `src/rooms/discord/monitor.ts`, `src/rooms/discord/transport.ts`
  - Slack: `src/rooms/slack/monitor.ts`, `src/rooms/slack/transport.ts`
- **Command Handling**: `src/rooms/command/*` (resolver, classifier, handler, rate limiter, context reduction)
- **Agent Runtime**: `src/agent/muaddib-agent-runner.ts` + `src/agent/tools/*`
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
- **Logging**: keep stdout concise, preserve structured/runtime detail in file logs

## Testing
- Vitest behavioral tests in `tests-ts/`
- Prefer extending existing tests instead of creating new files unless justified
- Keep room/command behavior parity covered when changing handler logic
- Tests should avoid mocking low-level API client constructors when validating control flow. Prefer patching router calls to inject fake responses, and ensure provider configs are referenced via `providers.*`.
- Do NOT introduce compatibility shims for legacy config fields; update tests and fixtures instead.
- When changing tests, prefer modifying/extending existing test files and cases rather than adding new test files, unless there is a compelling reason.

## Contributing Guideline
- All new changes follow the red-green-refactor TDD approach!
- For AI agents: When user is frustrated, stop and think why and consider whether not to append an additional behavioral instruction to this AGENTS.md file.

## Deprecated Python Runtime (auxiliary)
- Legacy invocation remains available temporarily via: `uv run muaddib`
- Keep operator docs clear that TypeScript runtime is primary
