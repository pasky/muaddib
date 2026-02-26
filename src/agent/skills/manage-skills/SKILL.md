---
name: manage-skills
description: Create and manage persistent workspace skills at /workspace/skills/.
---

Skills persist across sessions and appear in your system prompt.

Format: `/workspace/skills/<name>/SKILL.md` with YAML frontmatter:
```
---
name: <name>
description: <one-line>
---
<procedural instructions>
```

`name` must match directory name (lowercase, a-z, 0-9, hyphens).

Auxiliary files (scripts, templates, reference docs) can live alongside SKILL.md
in the same directory. Reference them with relative paths in the skill body -
they resolve against the skill directory.

Use existing write/edit/bash tools to manage. `ls /workspace/skills/` to list.
