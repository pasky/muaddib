/**
 * Load muaddib skills from the bundled skills directory.
 *
 * Skills are markdown files following the pi-coding-agent Skill format:
 *   src/agent/skills/<name>/SKILL.md
 *
 * At runtime, skill files are installed into the Gondolin VM at /skills/<name>/SKILL.md
 * so the agent can read them via the sandbox read tool.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type ResourceDiagnostic,
  type Skill,
} from "@mariozechner/pi-coding-agent";

import { getArcWorkspacePath, VM_SKILLS_BASE, VM_WORKSPACE_SKILLS_BASE } from "../gondolin/fs.js";

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

/**
 * Load workspace skills from the arc's workspace directory.
 *
 * Each skill's `filePath` is rewritten to the VM-local path
 * (`/workspace/skills/<name>/SKILL.md`) so `formatSkillsForPrompt` emits
 * locations the agent can read inside the sandbox.
 *
 * Returns `[]` if the directory doesn't exist.
 */
export interface WorkspaceSkillsResult {
  skills: LoadedSkill[];
  diagnostics: ResourceDiagnostic[];
}

export function loadWorkspaceSkills(arc: string): WorkspaceSkillsResult {
  const dir = join(getArcWorkspacePath(arc), "skills");
  if (!existsSync(dir)) return { skills: [], diagnostics: [] };

  try {
    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "workspace" });
    return {
      skills: skills.map((skill) => ({
        ...skill,
        content: readFileSync(skill.filePath, "utf-8"),
        filePath: `${VM_WORKSPACE_SKILLS_BASE}/${skill.name}/SKILL.md`,
      })),
      // Rewrite host paths to VM paths so the agent knows where to look.
      diagnostics: diagnostics.map((d) => ({
        ...d,
        path: d.path ? `${VM_WORKSPACE_SKILLS_BASE}/${d.path.slice(dir.length + 1)}` : d.path,
      })),
    };
  } catch {
    return { skills: [], diagnostics: [] };
  }
}

/**
 * Format a skills listing for inclusion in the system prompt suffix.
 *
 * Delegates to pi-agent-core's `formatSkillsForPrompt` which emits the
 * standard Agent Skills XML.  Because `loadBundledSkills` already rewrites
 * each skill's `filePath` to the VM-local path, the `<location>` elements
 * point where the agent can actually read them inside the sandbox.
 */
export function formatSkillsForVmPrompt(skills: LoadedSkill[], diagnostics: ResourceDiagnostic[] = []): string {
  let output = formatSkillsForPrompt(skills);
  if (diagnostics.length > 0) {
    const lines = diagnostics.map((d) => `- ${d.path ?? "unknown"}: ${d.message}`);
    output += "\n\nThe following workspace skills have issues and were not loaded. Consider fixing them when relevant:\n" + lines.join("\n");
  }
  return output;
}
