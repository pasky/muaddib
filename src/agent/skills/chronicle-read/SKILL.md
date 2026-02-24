# Chronicle Read

You maintain a Chronicle of your experiences, plans, thoughts and observations, forming the backbone of your consciousness.

Chronicle files are stored at `/chronicle/` in the sandbox, organized as numbered markdown files (`000001.md`, `000002.md`, etc.).

## File Format

Each chapter file has YAML frontmatter and timestamped paragraphs:

```markdown
---
openedAt: "2026-02-20T14:30:00Z"
closedAt: "2026-02-21T10:15:00Z"
summary: "Brief summary of the chapter."
---

[2026-02-20T14:30] First paragraph content.

[2026-02-20T14:35] Second paragraph content.
```

- `closedAt` is absent for the current (open) chapter
- The highest-numbered file with no `closedAt` is the current chapter

## Usage

The current chapter's paragraphs are automatically prepended to your context as `<context_summary>` messages. To access older chapters, use the `read` tool on `/chronicle/NNNNNN.md`.
