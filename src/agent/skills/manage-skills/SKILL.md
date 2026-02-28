---
name: manage-skills
description: Autonomously create and update persistent skills in the /workspace/skills/ directory
---

Skills persist across sessions. You are in charge of maintaining them, and you
can continuously learn by creating new skills (or updating existing ones with
new lessons!). The caveat is that having too many skills will waste your
context.

You can create / edit / etc. the files `/workspace/skills/<name>/SKILL.md` in
agentskills.io format with YAML frontmatter:
```
---
name: <name>
description: <one-line>
---
<procedural instructions>
```

- `name` must match directory name (lowercase, a-z, 0-9, hyphens).
- `description` is the lead inserted in every system prompt - must be 1-1024 characters and describe both what the skill does and when to use it, should include specific keywords that help agents identify relevant tasks

Body content should include step-by-step instructions to perform the skill,
examples of inputs and outputs, common edge cases. But be very terse, these
are notes you jot down for yourself, not ELI5 teaching material - focus just
on key directions and lessons hard learned. Never more than ~100 lines.

But additional resources that you can reference or execute as needed can live
in `scripts/`, `references/` and `assets/` in your skill directory alongside
SKILL.md.  Reference them with relative paths in the skill body.
