/**
 * Load muaddib skills from the bundled skills directory.
 *
 * Skills are markdown files following the pi-coding-agent Skill format:
 *   src/agent/skills/<name>/SKILL.md
 *
 * At runtime, skill files are installed into the Gondolin VM at /skills/<name>/SKILL.md
 * so the agent can read them via the sandbox read tool.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Directory containing bundled skill subdirectories.
 * Resolves to src/agent/skills/ in dev or dist/agent/skills/ in production.
 */
function getSkillsDir(): string {
  const candidates = [
    MODULE_DIR, // dist/agent/skills/ (when built)
    join(MODULE_DIR, "../../../src/agent/skills"), // fallback to src/ from dist/
  ];

  for (const dir of candidates) {
    try {
      const result = loadSkillsFromDir({ dir, source: "bundled" });
      if (result.skills.length > 0) return dir;
    } catch {
      // Try next candidate.
    }
  }

  return MODULE_DIR;
}

export interface LoadedSkill extends Skill {
  /** Raw markdown content of the skill file (for VM installation). */
  content: string;
}

/**
 * Load all bundled skills with their file contents.
 *
 * After loading, each skill's `filePath` is rewritten to the VM-local path
 * (`/skills/<name>/SKILL.md`) so that `formatSkillsForPrompt` emits
 * locations the agent can actually read inside the sandbox.  The host path
 * is only needed during `readFileSync` here and is not referenced afterward.
 */
export function loadBundledSkills(): LoadedSkill[] {
  const dir = getSkillsDir();
  const { skills } = loadSkillsFromDir({ dir, source: "bundled" });

  return skills.map((skill) => ({
    ...skill,
    content: readFileSync(skill.filePath, "utf-8"),
    filePath: `${VM_SKILLS_BASE}/${skill.name}/SKILL.md`,
  }));
}

/** VM-local base path where skills are installed. */
export const VM_SKILLS_BASE = "/skills";

/**
 * Format a skills listing for inclusion in the system prompt suffix.
 *
 * Delegates to pi-agent-core's `formatSkillsForPrompt` which emits the
 * standard Agent Skills XML.  Because `loadBundledSkills` already rewrites
 * each skill's `filePath` to the VM-local path, the `<location>` elements
 * point where the agent can actually read them inside the sandbox.
 */
export function formatSkillsForVmPrompt(skills: LoadedSkill[]): string {
  return formatSkillsForPrompt(skills);
}
