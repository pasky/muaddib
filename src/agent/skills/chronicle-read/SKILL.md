---
name: chronicle-read
description: Read chronicle memory chapters from /chronicle/
---

Chronicle files in the `/chronicle/` directory are numbered chapter files (`000001.md`, `000002.md`, etc.) with YAML frontmatter and timestamped paragraphs:

```markdown
---
openedAt: "2026-02-20T14:30:00Z"
closedAt: "2026-02-21T10:15:00Z"
summary: "Brief summary of the chapter."
---

[2026-02-20T14:30] First paragraph content.

[2026-02-20T14:35] Second paragraph content.
```

- `closedAt` absent = current (open) chapter
- Previous chapter summary and current chapter paragraphs were auto-prepended to your context as `<context_summary>` messages
- The chronicle is continuously written by your scaffold automatically, based on `/chat_history` chatter
- Use `read` tool on `/chronicle/NNNNNN.md` for older chapters
