/**
 * Gondolin sandbox tool factory.
 *
 * Provides read/write/edit/bash tools backed by a Gondolin micro-VM instead of
 * the host filesystem.  All VM lifecycle, networking, and filesystem logic lives
 * in `../gondolin/`; this module is the thin public surface that wires them into
 * the pi-coding-agent tool interfaces.
 */

import { existsSync } from "node:fs";

import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";

import type { GondolinConfig } from "../../config/muaddib-config.js";
import type { ToolsConfig } from "../../config/muaddib-config.js";
import type { Logger } from "../../app/logging.js";
import type { ArtifactContext, MuaddibTool, ToolSet } from "./types.js";
import {
  createShareArtifactTool,
  createDefaultShareArtifactExecutor,
  type SandboxReadFile,
} from "./artifact.js";
import {
  loadBundledSkills,
  loadWorkspaceSkills,
  formatSkillsForVmPrompt,
} from "../skills/load-skills.js";

import type { ArcEventsWatcher } from "../../events/watcher.js";

import {
  getArcChatHistoryDir,
  loadArcMemoryFile,
  createVmReadOps,
  createVmWriteOps,
  createVmEditOps,
  createVmBashOps,
  checkpointGondolinArc,
  createVmSession,
} from "../gondolin/index.js";

// ── Public API ─────────────────────────────────────────────────────────────

export interface GondolinToolsOptions {
  arc: string;
  serverTag?: string;
  channelName?: string;
  config: GondolinConfig;
  toolsConfig?: ToolsConfig;
  logger?: Logger;
  eventsWatcher?: ArcEventsWatcher;
}

/**
 * Create read/write/edit/bash tools backed by a Gondolin VM, plus a dispose
 * callback that must be called (via SessionRunner's onSessionEnd) when the
 * session ends — whether it succeeds or fails.
 *
 * One VM is created (and cached) per arc.  Each call to this function creates
 * a fresh session directory at /tmp/session-{uuid}/ which becomes the default
 * working directory for bash and the base for relative path resolution.
 * The last 8 session dirs are kept across checkpoints so the agent can revisit them.
 */
export function createGondolinTools(options: GondolinToolsOptions): ToolSet {
  const { arc, serverTag, channelName, config, toolsConfig, logger, eventsWatcher } = options;

  const bashTimeoutSeconds = config.bashTimeoutSeconds ?? 270;
  const vmOpTimeoutMs = bashTimeoutSeconds * 1000;

  const { getVm, sessionDir } = createVmSession({
    arc, config, artifactsUrl: toolsConfig?.artifacts?.url, vmOpTimeoutMs, logger, eventsWatcher,
  });

  const piReadTool = createReadTool(sessionDir, { operations: createVmReadOps(getVm, vmOpTimeoutMs, logger) });
  const piWriteTool = createWriteTool(sessionDir, { operations: createVmWriteOps(getVm, vmOpTimeoutMs) });
  const piEditTool = createEditTool(sessionDir, { operations: createVmEditOps(getVm, vmOpTimeoutMs, logger) });
  const piBashTool = createBashTool(sessionDir, { operations: createVmBashOps(getVm, bashTimeoutSeconds) });

  // share_artifact reads files from the VM and publishes them to the artifact store.
  const sandboxReadFile: SandboxReadFile = async (absolutePath: string): Promise<Buffer> => {
    const vm = await getVm();
    const content = await vm.fs.readFile(absolutePath, { signal: AbortSignal.timeout(vmOpTimeoutMs) });
    return Buffer.isBuffer(content) ? content : Buffer.from(content);
  };
  const artifactContext: ArtifactContext = { toolsConfig, logger };
  const shareArtifactExecutor = createDefaultShareArtifactExecutor(artifactContext, sandboxReadFile);
  const shareArtifactTool = createShareArtifactTool({ shareArtifact: shareArtifactExecutor });

  const tools: MuaddibTool[] = [
    { ...piReadTool, persistType: "none" } as MuaddibTool,
    { ...piWriteTool, persistType: "summary" } as MuaddibTool,
    { ...piEditTool, persistType: "summary" } as MuaddibTool,
    { ...piBashTool, persistType: "summary" } as MuaddibTool,
    shareArtifactTool,
  ];

  const systemPromptSuffix = buildSystemPromptSuffix(arc, sessionDir, toolsConfig, serverTag, channelName);

  const dispose = () => checkpointGondolinArc(arc, logger);

  return { tools, dispose, systemPromptSuffix };
}

// ── System prompt construction ──────────────────────────────────────────────

function buildSystemPromptSuffix(
  arc: string,
  sessionDir: string,
  toolsConfig?: ToolsConfig,
  serverTag?: string,
  channelName?: string,
): string {
  const chatHistorySuffix = existsSync(getArcChatHistoryDir(arc))
    ? " Need exact quotes or fine-grained chronology beyond the current context? Inspect daily JSONL logs in /chat_history/ (read-only), e.g. /chat_history/YYYY-MM-DD.jsonl."
    : "";

  const artifactsUrl = toolsConfig?.artifacts?.url;
  const artifactsSuffix = artifactsUrl
    ? ` Artifacts: your previously produced output attachments - any URLs that start with ${artifactsUrl}, read with download_artifact skill.`
    : "";

  const skills = loadBundledSkills();
  const { skills: workspaceSkills, diagnostics: skillDiagnostics } = loadWorkspaceSkills(arc);
  const allSkills = [...skills, ...workspaceSkills];
  const skillsSection = formatSkillsForVmPrompt(allSkills, skillDiagnostics);

  const memoryContent = loadArcMemoryFile(arc);
  const memorySuffix = memoryContent.trim()
    ? `\n<memory file="/workspace/MEMORY.md">\n${memoryContent}\n</memory>`
    : "";

  const arcSuffix =
    serverTag && channelName
      ? ` Arc: server="${serverTag}", channel="${channelName}".`
      : "";

  return (
    `Filesystem: /workspace persists across sessions; ${sessionDir} is your ephemeral working directory (last 8 session dirs in /tmp/session-* are kept).` +
    " Environment: Alpine Linux, uv venv is active." +
    arcSuffix +
    chatHistorySuffix +
    artifactsSuffix +
    skillsSection +
    memorySuffix
  );
}
