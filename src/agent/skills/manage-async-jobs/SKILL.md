---
name: manage-async-jobs
description: Using the /events/ directory to schedule one-shot (at) or periodic (cron) jobs that fire asynchronously, possibly in a thread
---

# Events

Create JSON files in `/events/`, use unique filenames.

## One-shot (fire once at a specific ISO 8601 time)

```json
{"type": "one-shot", "text": "Remind to go to sleep early", "at": "2026-02-26T23:00:00+01:00"}
```

Past files auto-delete.

## Periodic (cron schedule)

```json
{"type": "periodic", "text": "Check inbox", "schedule": "0 9 * * 1-5", "timezone": "Europe/Prague"}
```

The file persists until you delete it.

## Thread context

When running inside a thread, `$MUADDIB_THREAD_ID` is set in your shell
environment. Include it as `"threadId"` in the event JSON so the follow-up
fires back into the same thread instead of the main channel.

Example: `echo $MUADDIB_THREAD_ID` to get the value, then include it:
```json
{"type": "one-shot", "text": "Check status", "at": "2026-03-01T09:00:00Z", "threadId": "1234567890.123456"}
```

## Mode selection

The event text is processed like a normal message by you as an AI agent.
Prefix with a trigger such as !s/!a/!u to force a particular command mode.

## Guidelines

- Cron vs. heartbeat: Use cron for specific jobs with clear frequency. Use heartbeat for jobs to be done generally "frequently / continuously".
- Consolidate related checks into a single periodic event rather than many separate ones.
- Explicitly instruct cron jobs when & how should they say something - the job's agent will be advised to stay silent by default.
- Keep number and frequency of events reasonable - each firing is a full agent invocation.
