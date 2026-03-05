/**
 * Unit tests for workspace skill loading — specifically surfacing
 * diagnostics for skills with missing/malformed frontmatter.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { loadWorkspaceSkills, formatSkillsForVmPrompt } from "../src/agent/skills/load-skills.js";

// Stub getArcWorkspacePath so we control the directory.
vi.mock("../src/agent/gondolin/fs.js", () => ({
  VM_SKILLS_BASE: "/skills",
  VM_WORKSPACE_SKILLS_BASE: "/workspace/skills",
  getArcWorkspacePath: (arc: string) => join(tmpdir(), `load-skills-test-${process.pid}`, arc),
}));

const testRoot = join(tmpdir(), `load-skills-test-${process.pid}`);

function arcSkillsDir(arc: string): string {
  return join(testRoot, arc, "skills");
}

describe("loadWorkspaceSkills", () => {
  beforeEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("loads a skill with proper frontmatter", () => {
    const dir = arcSkillsDir("test-arc");
    mkdirSync(join(dir, "good-skill"), { recursive: true });
    writeFileSync(
      join(dir, "good-skill", "SKILL.md"),
      "---\ndescription: A good skill\n---\n# Good Skill\nDoes things.\n",
    );

    const { skills, diagnostics } = loadWorkspaceSkills("test-arc");
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("good-skill");
    expect(skills[0].description).toBe("A good skill");
    expect(skills[0].filePath).toBe("/workspace/skills/good-skill/SKILL.md");
    expect(diagnostics).toHaveLength(0);
  });

  it("returns diagnostics for a skill with no frontmatter", () => {
    const dir = arcSkillsDir("test-arc");
    mkdirSync(join(dir, "no-frontmatter"), { recursive: true });
    writeFileSync(
      join(dir, "no-frontmatter", "SKILL.md"),
      "# My Skill\n\nJust markdown, no frontmatter.\n",
    );

    const { skills, diagnostics } = loadWorkspaceSkills("test-arc");
    expect(skills).toHaveLength(0);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0].path).toBe("/workspace/skills/no-frontmatter/SKILL.md");
  });

  it("loads proper skills and returns diagnostics for malformed ones", () => {
    const dir = arcSkillsDir("test-arc");
    mkdirSync(join(dir, "proper"), { recursive: true });
    writeFileSync(
      join(dir, "proper", "SKILL.md"),
      "---\ndescription: Proper one\n---\n# Proper\n",
    );
    mkdirSync(join(dir, "broken"), { recursive: true });
    writeFileSync(join(dir, "broken", "SKILL.md"), "# Broken\nNo frontmatter here.\n");

    const { skills, diagnostics } = loadWorkspaceSkills("test-arc");
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("proper");
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((d) => d.path?.includes("broken"))).toBe(true);
  });

  it("returns empty for non-existent arc", () => {
    const { skills, diagnostics } = loadWorkspaceSkills("no-such-arc");
    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});

describe("formatSkillsForVmPrompt with diagnostics", () => {
  it("appends diagnostics to the prompt", () => {
    const output = formatSkillsForVmPrompt([], [
      { type: "warning", message: "missing description", path: "/workspace/skills/broken/SKILL.md" },
    ]);
    expect(output).toContain("workspace skills have issues");
    expect(output).toContain("/workspace/skills/broken/SKILL.md");
    expect(output).toContain("missing description");
  });

  it("omits diagnostics section when there are none", () => {
    const output = formatSkillsForVmPrompt([]);
    expect(output).not.toContain("issues");
  });
});
