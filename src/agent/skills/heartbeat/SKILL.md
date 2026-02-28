---
name: heartbeat
description: Using /workspace/HEARTBEAT.md for periodic self-directed background work and proactive checks
---

# Heartbeat

Write a `/workspace/HEARTBEAT.md` file to schedule recurring background work.
The system checks this file periodically (default: every 60 minutes).
If it exists and has content, you'll be invoked with that content as a periodic event.

Keep the file small to limit token burn. Use it for:
- Rotating checks (email, calendar, notifications)
- Proactive background work (memory maintenance, project status)
- Short checklists of things to monitor

If nothing needs attention, respond NULL (standard periodic event behavior).
Delete or empty the file to stop heartbeat invocations.
