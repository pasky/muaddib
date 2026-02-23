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

import { loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent";

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
 * Returns skills ready to be installed into a Gondolin VM.
 */
export function loadBundledSkills(): LoadedSkill[] {
  const dir = getSkillsDir();
  const { skills } = loadSkillsFromDir({ dir, source: "bundled" });

  return skills.map((skill) => ({
    ...skill,
    content: readFileSync(skill.filePath, "utf-8"),
  }));
}

/** VM-local base path where skills are installed. */
export const VM_SKILLS_BASE = "/skills";

/**
 * Format a skills listing for inclusion in the system prompt suffix.
 * Points the agent to VM-local paths (not host paths).
 */
export function formatSkillsForVmPrompt(skills: LoadedSkill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";

  const lines = [
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
  ];

  for (const skill of visible) {
    const vmPath = `${VM_SKILLS_BASE}/${skill.name}/SKILL.md`;
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(vmPath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
