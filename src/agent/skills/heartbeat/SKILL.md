---
name: heartbeat
description: Using /workspace/HEARTBEAT.md for periodic self-directed background work and proactive checks
---

# Heartbeat

Write a `/workspace/HEARTBEAT.md` file to schedule recurring background work.
This file is checked frequently (hourly or so; may vary) and you will get
opportunity to get that work done every heartbeat.

Keep the file small to limit token burn. Use it for:
- Rotating checks (systems, sites, updates, events, notifications)
- Proactive background work (memory maintenance, project status)
- Short checklists of things to monitor

Explicitly instruct heartbeat jobs when & how should they say something - the
job's agent will be advised to stay silent by default.

Delete or empty the file to stop heartbeat invocations.

Cron vs. heartbeat: Use cron for specific jobs with clear frequency. Use heartbeat for jobs to be done generally "frequently / continuously".
