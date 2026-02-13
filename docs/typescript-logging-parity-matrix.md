# TypeScript Logging Parity Matrix (Direct Command Path)

Date: 2026-02-13

Scope: direct message command flow (`IRC ingest -> command resolution -> agent/tool loop -> persistence/cost followups`) with Python references:
- `muaddib/rooms/irc/monitor.py`
- `muaddib/rooms/command.py`
- `muaddib/agentic_actor/actor.py`
- `muaddib/providers/anthropic.py`

Legend:
- ✅ parity implemented in TS runtime
- ◐ partial parity (reduced detail)

| Phase | Python event meaning (severity) | Route | TS parity status | TS implementation |
|---|---|---|---|---|
| IRC ingest | Processing incoming IRC event (`debug`) | system | ✅ | `ts/src/rooms/irc/monitor.ts` logs `Processing message event` |
| IRC ingest | Invalid IRC event skipped (`debug`) | system | ✅ | `monitor.ts` logs `Skipping invalid message event` |
| IRC ingest | Bridged sender normalized (`debug`) | system | ✅ | `monitor.ts` logs normalized sender mapping |
| IRC ingest | Ignored user (`debug`) | system | ✅ | `monitor.ts` logs ignored nick+normalized nick |
| IRC ingest | Bot nick resolved (`debug`) | system | ✅ | `monitor.ts` logs nick cache population |
| IRC ingest | Bot nick lookup failure (`error`) | system | ✅ | `monitor.ts` logs lookup failure and continues |
| Direct command start | Direct command handling lifecycle (`info`) | per-message + system | ✅ | `command-handler.ts` logs `Handling direct command` and `Received command` |
| Parse/resolve | Parse error (`warning`) | per-message + system | ✅ | `command-handler.ts` logs `Command parse error` |
| Parse/resolve | Help path (`debug`) | per-message + system | ✅ | `command-handler.ts` logs `Sending help message` |
| Parse/resolve | Model override (`debug`) | per-message + system | ✅ | `command-handler.ts` logs `Overriding model` |
| Parse/resolve | Explicit vs automatic mode routing (`debug`) | per-message + system | ✅ | `command-handler.ts` logs explicit/automatic mode resolution + channel policy |
| Parse/resolve | Final command resolution (`info`) | per-message + system | ✅ | `command-handler.ts` logs `Resolved direct command` |
| Classifier | Invalid classifier output (`warning`) | per-message + system | ✅ | `classifier.ts` logs `Invalid mode classification response` |
| Classifier | Classifier execution failure (`error`) | per-message + system | ✅ | `classifier.ts` logs `Error classifying mode` |
| Debounce | Followup merge count (`debug`) | per-message + system | ✅ | `command-handler.ts` logs debounced followup count |
| Rate limiting | User rate-limit triggered (`warning`) | per-message + system | ✅ | `command-handler.ts` logs `Rate limit triggered` |
| Agent loop | Iteration progress (`info`) | per-message + system | ✅ | `muaddib-agent-runner.ts` logs `Agent iteration x/y` |
| Agent loop | Iteration overflow (`warning`) | per-message + system | ✅ | runner logs `Exceeding max iterations...` |
| Agent loop | Empty completion retry (`warning`) | per-message + system | ✅ | runner logs retry attempts |
| Agent loop | Tool execution summary (`info`) | per-message + system | ✅ | runner logs `Tool <name> executed: ...` |
| Agent loop | Tool execution failure (`warning`) | per-message + system | ✅ | runner logs `Tool <name> failed: ...` |
| Agent loop | Agent iteration hard failure (`error`) | per-message + system | ✅ | runner logs `Agent iteration failed:` |
| Command/actor boundary | Agent execution failure (`error`) | per-message + system | ✅ | command handler logs `Error during agent execution` |
| Refusal fallback | Primary refusal fallback transition (`info`) | per-message + system | ✅ | command handler logs fallback trigger + fallback model |
| Response policy | Oversized response artifact fallback (`info`) | per-message + system | ✅ | command handler logs bytes/max before artifact conversion |
| Response dispatch | Response send summary with mode/cost/response (`info`) | per-message + system | ✅ | command handler logs `Sending direct response` |
| Persistence | LLM model parse failure (`warning`) | per-message + system | ✅ | command handler logs `Could not parse model spec` |
| Persistence | Response persistence lifecycle (`info`) | per-message + system | ✅ | command handler logs persist start/store completion |
| Cost followup | Per-message cost followup sent (`info`) | per-message + system | ✅ | command handler logs `Sending cost followup` |
| Cost followup | Daily cost milestone sent (`info`) | per-message + system | ✅ | command handler logs `Sending daily cost milestone` |
| No-answer path | Agent declined to answer (`info`) | per-message + system | ✅ | command handler logs `Agent chose not to answer` |
| Provider payload internals | Raw request/response payload debug + retry internals (`debug/info/warning/error`) | per-message + system | ◐ | TS does not emit provider payload dumps equivalent to Python provider clients; parity retained at command/actor lifecycle level |

## Summary

This parity fix closes direct-command logging gaps for event coverage and severity semantics at the runtime command/agent level, and ensures those logs flow into per-message files via runtime logger propagation.
