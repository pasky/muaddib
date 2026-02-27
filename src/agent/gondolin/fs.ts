/**
 * Arc-path helpers and VM mount construction.
 *
 * Groups all filesystem-layout knowledge (where arcs, workspaces, checkpoints,
 * chronicle, chat-history and events live) and the logic that assembles the
 * VFS mount table handed to Gondolin's VM constructor.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { VirtualProvider } from "@earendil-works/gondolin";

import { getMuaddibHome } from "../../config/paths.js";
import type { Logger } from "../../app/logging.js";
import type { ArcEventsWatcher } from "../../events/watcher.js";
import { SizeLimitProvider } from "./fs/size-limit-provider.js";
import { NotifyingProvider } from "./fs/notifying-provider.js";
import type { LoadedSkill } from "../skills/load-skills.js";

/** VM-internal mount point for bundled skills. */
export const VM_SKILLS_BASE = "/skills";

/** VM-internal path for workspace skills (inside the /workspace RealFS mount). */
export const VM_WORKSPACE_SKILLS_BASE = "/workspace/skills";

// ── Arc ID / workspace path / checkpoint path ──────────────────────────────
// Arc IDs are already filesystem-safe (percent-encoded at construction in
// buildArc).  No further normalisation needed here.

export function getArcWorkspacePath(arc: string): string {
  return join(getMuaddibHome(), "arcs", arc, "workspace");
}

/** Checkpoint file lives *outside* the VFS-mounted workspace so the VM cannot tamper with it. */
export function getArcCheckpointPath(arc: string): string {
  return join(getMuaddibHome(), "arcs", arc, "checkpoint.qcow2");
}

export function getArcChronicleDir(arc: string): string {
  return join(getMuaddibHome(), "arcs", arc, "chronicle");
}

export function getArcChatHistoryDir(arc: string): string {
  return join(getMuaddibHome(), "arcs", arc, "chat_history");
}

export function getArcEventsDir(arc: string): string {
  return join(getMuaddibHome(), "arcs", arc, "events");
}

/**
 * Best-effort read of `/workspace/MEMORY.md` for the given arc.
 * Returns the file content, or `""` if the file is absent or unreadable.
 */
export function loadArcMemoryFile(arc: string): string {
  const memoryPath = join(getArcWorkspacePath(arc), "MEMORY.md");
  if (!existsSync(memoryPath)) return "";
  try {
    return readFileSync(memoryPath, "utf8");
  } catch {
    return "";
  }
}

// ── VM mount table ─────────────────────────────────────────────────────────

export interface CreateVmMountsOptions {
  arc: string;
  workspacePath: string;
  workspaceSizeMb: number;
  skills: LoadedSkill[];
  eventsWatcher?: ArcEventsWatcher;
  logger?: Logger;
}

/**
 * Build the VFS `mounts` record that Gondolin's VMOptions expects.
 *
 * Dynamically imports Gondolin providers (RealFSProvider, ReadonlyProvider,
 * MemoryProvider) so the rest of the codebase can remain free of a hard
 * dependency on the Gondolin package at import time.
 */
export async function createVmMounts(
  opts: CreateVmMountsOptions,
): Promise<Record<string, VirtualProvider>> {
  const {
    RealFSProvider,
    ReadonlyProvider,
    MemoryProvider: MemProviderClass,
  } = await import("@earendil-works/gondolin");

  const workspaceLimitBytes = opts.workspaceSizeMb * 1024 * 1024;
  const mounts: Record<string, VirtualProvider> = {
    "/workspace": new SizeLimitProvider(
      new RealFSProvider(opts.workspacePath), workspaceLimitBytes, opts.workspacePath),
  };

  if (opts.skills.length > 0) {
    const skillsFs = new MemProviderClass();
    for (const skill of opts.skills) {
      skillsFs.mkdirSync(`${skill.name}`, { recursive: true });
      skillsFs.writeFileSync!(`${skill.name}/SKILL.md`, skill.content, { encoding: "utf8" });
    }
    skillsFs.setReadOnly();
    mounts[VM_SKILLS_BASE] = skillsFs;
  }

  const chronicleDir = getArcChronicleDir(opts.arc);
  if (existsSync(chronicleDir)) {
    mounts["/chronicle"] = new ReadonlyProvider(new RealFSProvider(chronicleDir));
  }

  const chatHistoryDir = getArcChatHistoryDir(opts.arc);
  if (existsSync(chatHistoryDir)) {
    mounts["/chat_history"] = new ReadonlyProvider(new RealFSProvider(chatHistoryDir));
  }

  // Mount /events/ for arc event scheduling (one-shot and cron jobs).
  const eventsDir = getArcEventsDir(opts.arc);
  mkdirSync(eventsDir, { recursive: true });
  const EVENTS_QUOTA_BYTES = 1 * 1024 * 1024; // 1 MB
  const eventsBackend = new NotifyingProvider(
    new RealFSProvider(eventsDir),
    (name) => opts.eventsWatcher?.onFileWritten(opts.arc, name),
    (name) => opts.eventsWatcher?.onFileDeleted(opts.arc, name),
  );
  mounts["/events"] = new SizeLimitProvider(eventsBackend, EVENTS_QUOTA_BYTES, eventsDir);

  return mounts;
}
