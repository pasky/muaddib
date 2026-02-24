---
name: chronicle-read
description: Read chronicle memory chapters from /chronicle/ in the sandbox.
---

Chronicle files at `/chronicle/` are numbered markdown files (`000001.md`, `000002.md`, etc.) with YAML frontmatter (`openedAt`, `closedAt`, `summary`) and timestamped paragraphs:

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
- Current chapter paragraphs are auto-prepended to context as `<context_summary>` messages
- Use `read` tool on `/chronicle/NNNNNN.md` for older chapters
