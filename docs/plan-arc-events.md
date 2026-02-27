# Arc Events (Cron) Support — Implementation Plan

## Overview

Add scheduled event support to arcs so the agent can create one-shot and periodic
(cron) tasks that fire asynchronously, triggering a normal command run in the
arc's room.

---

## 1. Event File Format

Events live at `/events/` inside the Gondolin VM, backed by a separate host
directory at `$MUADDIB_HOME/arcs/<arc>/events/` (not inside the workspace).

```
/events/
├── morning-github-check.json
├── remind-dentist-1740500000.json
└── webhook-check.json
```

Two event types:

```jsonc
// One-shot — fires once at a specific time, auto-deletes
{
  "type": "one-shot",
  "text": "Remind pasky about dentist appointment",
  "at": "2026-02-26T09:00:00+01:00"
}

// Periodic — fires on cron schedule, persists until manually deleted
{
  "type": "periodic",
  "text": "Check GitHub issues and summarize",
  "schedule": "0 9 * * 1-5",
  "timezone": "Europe/Prague"
}
```

No `channelId` — the arc already implies the target room.  No `trigger` field —
if the agent wants a specific mode, it prefixes `text` with `!s`, `!a`, etc.
Otherwise the text goes through the mode classifier like any human message.

---

## 2. NotifyingProvider (VFS Mount)

The `/events/` mount uses a thin `NotifyingProvider` that wraps `RealFSProvider`
plus the quota enforcer wrapper (fixed 1MB quota)
and calls a callback on write/unlink.  This replaces `fs.watch()` entirely —
notifications are synchronous with the filesystem operation, so there are no
partial-write races or platform-specific inotify issues.

```typescript
class NotifyingProvider extends RealFSProvider {
  constructor(hostDir: string, private onWrite: (name: string) => void,
                                private onDelete: (name: string) => void) { ... }

  writeFileSync(path, data, opts?) {
    super.writeFileSync(path, data, opts);
    if (path.endsWith(".json")) this.onWrite(basename(path));
  }

  unlinkSync(path) {
    super.unlinkSync(path);
    if (path.endsWith(".json")) this.onDelete(basename(path));
  }
}
```

Mounted in `createGondolinTools` alongside `/workspace`, `/chronicle`, etc.:

```typescript
mounts["/events"] = new NotifyingProvider(eventsDir, onWrite, onDelete);
```

The events host directory is `$MUADDIB_HOME/arcs/<arc>/events/`, separate from
the workspace.  Benefits:
- Not affected by workspace size quota
- Can't be wiped by `rm -rf /workspace`
- Clean separation of control plane vs. workspace content

---

## 3. ArcEventsWatcher

Central watcher that manages all scheduled events across all arcs.  Uses the
[croner](https://www.npmjs.com/package/croner) library for cron scheduling.

```typescript
class ArcEventsWatcher {
  /** Called by NotifyingProvider callbacks when agent writes/deletes event files. */
  onFileWritten(arc: string, filename: string): void;
  onFileDeleted(arc: string, filename: string): void;

  /** Scan existing event files on startup (for events created in previous sessions). */
  scanArc(arc: string): void;

  /** Fire an event: build synthetic message, call gateway.inject(). */
  private fire(arc: string, filename: string, event: ParsedEvent): void;

  /** Lifecycle. */
  start(): void;
  stop(): void;
}
```

Make it live in src/events/ as it's a cross-cutting concern. (in the future,
heartbeat handler will also live there)

Behaviour:
- **One-shot**: schedules a `setTimeout`.  If `at` is in the past, discards
  the file without firing (stale).  Auto-deletes the file after firing.
- **Periodic**: creates a `Cron` job via croner.  File persists until the agent
  deletes it.
- **On startup**: `scanArc()` is called for each arc that has an events dir,
  picking up periodic events from previous sessions and discarding stale
  one-shots.
- **No hard limit** on event count.  The existing room-level `RateLimiter`
  prevents event-storm damage at firing time.  The skill documentation guides
  the agent to keep events reasonable.
- **Maximum frequency limit** of `*/30` minutes, events with higher frequency
  get ratelimited.

---

## 4. RoomGateway

A thin routing layer so anything (events, future heartbeat, etc.) can inject
commands or send messages to any arc.

```typescript
interface TransportHandler {
  /** Inject a synthetic direct command into the command pipeline. */
  inject(serverTag: string, channelName: string, content: string): Promise<void>;
  /** Send a message to a channel, like sendResponse. */
  send(serverTag: string, channelName: string, text: string): Promise<void>;
}

class RoomGateway {
  register(transport: string, handler: TransportHandler): void;
  inject(arc: string, content: string): Promise<void>;
  send(arc: string, text: string): Promise<void>;
}
```

Routing from arc to transport:
- Arc is `serverTag#channelName` (via `buildArc`)
- `discord:*` serverTags → `"discord"` transport
- `slack:*` serverTags → `"slack"` transport
- Everything else → `"irc"` transport

Each room monitor registers once at startup:

- **IRC**: `TransportHandler.inject()` builds a `RoomMessage`, calls
  `commandHandler.handleIncomingMessage({ isDirect: true, sendResponse })`.
  `TransportHandler.send()` is analogous to sendResponse.

- **Discord / Slack**: same pattern with their respective sender APIs.

The gateway is created in `main.ts` and passed to both the room monitors (for
registration) and the `ArcEventsWatcher` (for dispatching).

---

## 5. Synthetic Message Format

When an event fires, the watcher calls `gateway.inject(arc, content, "event")`.
The transport's `inject()` builds a `RoomMessage` and feeds it through
`handleIncomingMessage` as a direct command.

The cron content has a nudge prefix + event metadata:

```
----------
<meta>The above was current conversation context, which may or may not be relevant at all to the task at hand - you have just been launched asynchronously to handle a pre-scheduled instruction. Anything you write will be seen outside as 'out of the blue' so keep your chatter to only relevant notices it's important to share - likely, you will not say anything at all, unlikely it was explicitly asked for below. Finish with string NULL once done if no notification needs to be sent.</meta>
[EVENT:/events/morning-check.json:periodic:0 9 * * 1-5] Check GitHub issues and summarize
```

The at content has a nudge refix w/o the silence emphasis:

```
----------
<meta>The above was current conversation context, which may or may not be relevant at all to the task at hand - you have just been launched asynchronously to handle a pre-scheduled instruction. Anything you write will be seen outside as 'out of the blue', speak accordingly.</meta>
[EVENT:/events/remind-dentist-1740500000.json:one-shot:2026-02-26T09:00:00+01:00] Remind pasky about dentist appointment
```

This goes through the standard command pipeline, so the agent gets:
- **System prompt**: full mode-resolved prompt (via classifier or `!trigger` prefix in text)
- **Conversation history**: last N messages per mode's `historySize`
- **Tools**: full tool access (gondolin VM, web search, oracle, etc.)

The `[EVENT:...]` prefix lets the agent know this is a scheduled event.  The
`<meta>` nudge tells it to be conservative with output and use NULL when there's
nothing to report.

### NULL handling

The existing `isNullSentinel()` in `command-executor.ts` already suppresses
output for NULL responses (used by proactive interjection).  Event-triggered
runs reuse the same convention — no new code needed in the executor.

---

## 6. Events Skill

Events are documented as a bundled skill for progressive discovery, not baked
into the system prompt.

File: `src/agent/skills/manage-events/SKILL.md`

```markdown
---
name: manage-async-jobs
description: Using `/events/` to schedule one-shot or periodic (cron) jobs that fire asynchronously
---

# Events

Create JSON files in `/events/`, use unique filenames.

## One-shot (fire once at a specific ISO 8601 time)

\`\`\`json
{"type": "one-shot", "prompt": "Remind to go to sleep early", "at": "2026-02-26T23:00:00+01:00"}
\`\`\`

Past files auto-delete.

## Periodic (cron schedule)

\`\`\`json
{"type": "periodic", "prompt": "Check inbox", "schedule": "0 9 * * 1-5", "timezone": "Europe/Prague"}
\`\`\`

The file persists until you delete it.

## Mode selection

The event prompt is processed like a normal message by you as an AI agent.
Prefix with a trigger such as !s/!a/!u to force a particular command mode.

## Guidelines

- Consolidate related checks into a single periodic event rather than many separate ones.
- Explicitly instruct cron jobs when & how should they say something - the job's agent will be advised to stay silent by default.
- Keep number and frequency of events reasonable - each firing is a full agent invocation.
```

Loaded via `loadBundledSkills()` in `src/agent/skills/load-skills.ts`.

---

## 7. Wiring (main.ts)

```
main.ts
  ├── createMuaddibRuntime()
  ├── gateway = new RoomGateway()
  ├── eventsWatcher = new ArcEventsWatcher(gateway, logger)
  ├── monitors = createMonitors(runtime, gateway)   // monitors register transports
  ├── eventsWatcher.start()                         // scan existing arcs for events
  └── Promise.all(monitors.map(m => m.run()))
```

---

## 8. Gondolin Integration

In `createGondolinTools()`:

1. Create the events host dir: `$MUADDIB_HOME/arcs/<arc>/events/`
2. Mount `NotifyingProvider` at `/events/` with callbacks that notify the
   `ArcEventsWatcher`
3. The watcher reference is passed via options (added to `CreateGondolinToolsOptions`)

On `scanArc(arc)` (called at startup or first VM attach), the watcher reads
all existing `.json` files from the host events dir and schedules them.

---

## 9. Implementation Order

1. **`croner` dependency**: `npm install croner`
2. **`RoomGateway`**: `src/rooms/room-gateway.ts` — thin arc→transport router
3. **`ArcEventsWatcher`**: `src/events/arc-events-watcher.ts` — event parsing,
   scheduling, firing
4. **`NotifyingProvider`**: `src/agent/tools/notifying-provider.ts` — VFS wrapper
5. **Gondolin integration**: mount `/events/`, wire NotifyingProvider → watcher
6. **Transport registration**: each monitor registers its `TransportHandler` in
   `fromRuntime()` (IRC, Discord, Slack)
7. **Events skill**: `src/agent/skills/events/SKILL.md`
8. **Main wiring**: `main.ts` creates gateway + watcher, passes to monitors
9. **Tests**: watcher unit tests (parsing, scheduling, one-shot expiry, periodic
   firing, NULL suppression), gateway routing tests, NotifyingProvider tests
10. **CLI integration**: ensure `cli/message-mode.ts` works with events (may need
    a no-op gateway; definitely should not trigger events)

---

## 10. Files to Create / Modify

### New files
- `src/rooms/room-gateway.ts` — RoomGateway class
- `src/events/watcher.ts` — ArcEventsWatcher class
- `src/agent/tools/notifying-provider.ts` — NotifyingProvider VFS wrapper
- `src/agent/skills/manage-async-jobs/SKILL.md` — skill documentation
- `tests/events/watcher.test.ts`
- `tests/rooms/room-gateway.test.ts`

### Modified files
- `src/app/main.ts` — create gateway + watcher, pass to monitors
- `src/agent/tools/gondolin-tools.ts` — mount `/events/`, wire NotifyingProvider
- `src/rooms/irc/monitor.ts` — register transport on gateway
- `src/rooms/discord/monitor.ts` — register transport on gateway
- `src/rooms/slack/monitor.ts` — register transport on gateway
- `src/agent/skills/load-skills.ts` — include events skill in bundled skills
- `src/cli/message-mode.ts` — pass no-op or real gateway ???
- `package.json` — add `croner` dependency
