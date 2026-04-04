---
name: chronicle-read
description: Reconstruct high-level past events (decisions, commitments, timelines) from /chronicle chapters. Use for longer-term recall beyond what <context_summary> paragraphs cover — arc of past discussions, decisions made, what happened last week(s).
---

Chronicle files in `/chronicle/` (read-only, auto-maintained) are numbered chapter files (`000001.md`, `000002.md`, etc.) with YAML frontmatter and timestamped narrative paragraphs:

```markdown
---
openedAt: "2026-02-20T14:30:00Z"
closedAt: "2026-02-21T10:15:00Z"
summary: "Brief summary of the chapter."
---

[2026-02-20T14:30] First paragraph content.

[2026-02-20T14:35] Second paragraph content.
```

## What's already in your context
- Current chapter paragraphs are auto-prepended as `<context_summary>` messages
- These cover only most recent history — older chapters require explicit lookup

## When to use chronicle vs chat_history
- **Chronicle**: narrative summaries — good for "what was discussed about X", "what decisions were made", longer-term arcs
- **chat_history**: raw JSONL transcript logs — good for specific quotes, artifact URLs, exact tool calls, who said what

## How to use
- `closedAt` absent = current (open) chapter
- Grep `summary:` lines across chapters to find relevant periods
- `read /chronicle/NNNNNN.md` for full chapter content
- The chronicle is written automatically from `/chat_history/` chatter
