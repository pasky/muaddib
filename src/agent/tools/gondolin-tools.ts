/**
 * Gondolin sandbox integration.
 *
 * Provides read/write/edit/bash tools backed by a Gondolin micro-VM instead of
 * the host filesystem.  One VM per arc (persistent, reused across invocations).
 * Each invocation gets an ephemeral working directory at /tmp/session-{uuid}/.
 * Persistent workspace is mounted from $MUADDIB_HOME/workspaces/<arcId>/ at /workspace.
 *
 * Network policy:
 *   - Internal RFC-1918 and loopback ranges are blocked by default (gondolin default).
 *   - Additional blocked hosts and CIDR ranges are taken from config.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, posix } from "node:path";

import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";

import type { VM } from "@earendil-works/gondolin";

import { getMuaddibHome } from "../../config/paths.js";
import type { GondolinConfig } from "../../config/muaddib-config.js";
import type { Logger } from "../../app/logging.js";
import type { MuaddibTool } from "./types.js";

// ── Arc ID / workspace path ────────────────────────────────────────────────

export function normalizeArcId(arc: string): string {
  return createHash("sha256").update(arc).digest("hex").slice(0, 16);
}

export function getArcWorkspacePath(arc: string): string {
  return join(getMuaddibHome(), "workspaces", normalizeArcId(arc));
}

// ── VM cache: one VM per arc ───────────────────────────────────────────────

const vmCache = new Map<string, VM>();
const vmCacheLocks = new Map<string, Promise<VM>>();
/** Active session count per arcId — prevents checkpointing while another session is still running. */
const vmActiveSessions = new Map<string, number>();

async function ensureVm(
  arc: string,
  config: GondolinConfig,
  logger?: Logger,
): Promise<VM> {
  const arcId = normalizeArcId(arc);

  const cached = vmCache.get(arcId);
  if (cached) return cached;

  const pending = vmCacheLocks.get(arcId);
  if (pending) return pending;

  const createPromise = (async () => {
    const {
      VM: VMClass,
      VmCheckpoint,
      RealFSProvider,
      createHttpHooks,
    } = await import("@earendil-works/gondolin");

    const workspacePath = getArcWorkspacePath(arc);
    mkdirSync(workspacePath, { recursive: true });

    const blockedHosts = config.blockedHosts ?? [];
    const blockedCidrs = config.blockedCidrs ?? [];

    const { httpHooks } = createHttpHooks({
      blockInternalRanges: true,
      isRequestAllowed: (req) => {
        try {
          const url = new URL(req.url);
          return !isHostBlocked(url.hostname, blockedHosts);
        } catch {
          return false;
        }
      },
      isIpAllowed: (info) => {
        if (blockedCidrs.length === 0) return true;
        return !blockedCidrs.some((cidr) => isIpInCidr(info.ip, cidr));
      },
    });

    const vmOptions = {
      vfs: {
        mounts: {
          "/workspace": new RealFSProvider(workspacePath),
        },
      },
      httpHooks,
    };

    const checkpointPath = join(workspacePath, "vm-checkpoint.qcow2");
    let vm: import("@earendil-works/gondolin").VM;
    if (existsSync(checkpointPath)) {
      try {
        const checkpoint = VmCheckpoint.load(checkpointPath);
        vm = await checkpoint.resume(vmOptions);
        logger?.info(`Gondolin VM resumed from checkpoint for arc ${arcId}: ${checkpointPath}`);
      } catch (err) {
        logger?.warn(`Gondolin checkpoint restore failed, starting fresh VM for arc ${arcId}`, String(err));
        vm = await VMClass.create(vmOptions);
      }
    } else {
      vm = await VMClass.create(vmOptions);
      logger?.info(`Gondolin VM started for arc ${arcId}, workspace: ${workspacePath}`);
    }

    vmCache.set(arcId, vm);
    return vm;
  })();

  vmCacheLocks.set(arcId, createPromise);
  try {
    const vm = await createPromise;
    return vm;
  } finally {
    vmCacheLocks.delete(arcId);
  }
}

// ── Network filtering helpers ──────────────────────────────────────────────

function isHostBlocked(hostname: string, blockedHosts: string[]): boolean {
  const host = hostname.toLowerCase();
  for (const pattern of blockedHosts) {
    const p = pattern.toLowerCase();
    if (p.startsWith("*.")) {
      // "*.foo.com" matches "foo.com" and "bar.foo.com"
      const suffix = p.slice(1); // ".foo.com"
      if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
    } else {
      if (host === p) return true;
    }
  }
  return false;
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const slashIdx = cidr.lastIndexOf("/");
  if (slashIdx === -1) return false;
  const prefix = cidr.slice(0, slashIdx);
  const prefixLength = parseInt(cidr.slice(slashIdx + 1), 10);

  if (prefix.includes(":") && ip.includes(":")) {
    return isIPv6InPrefix(ip, prefix, prefixLength);
  }
  if (!prefix.includes(":") && !ip.includes(":")) {
    return isIPv4InPrefix(ip, prefix, prefixLength);
  }
  return false;
}

function expandIPv6(ip: string): number[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const val = parseInt(g, 16);
    if (Number.isNaN(val)) return null;
    bytes.push((val >> 8) & 0xff, val & 0xff);
  }
  return bytes;
}

function isIPv6InPrefix(ip: string, prefix: string, length: number): boolean {
  const ipBytes = expandIPv6(ip);
  const prefixBytes = expandIPv6(prefix);
  if (!ipBytes || !prefixBytes) return false;
  const fullBytes = Math.floor(length / 8);
  const remainingBits = length % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== prefixBytes[i]) return false;
  }
  if (remainingBits > 0) {
    const mask = 0xff & (0xff << (8 - remainingBits));
    if ((ipBytes[fullBytes]! & mask) !== (prefixBytes[fullBytes]! & mask)) return false;
  }
  return true;
}

function isIPv4InPrefix(ip: string, prefix: string, length: number): boolean {
  const parseIPv4 = (s: string) => {
    const parts = s.split(".").map(Number);
    if (parts.length !== 4 || parts.some((b) => Number.isNaN(b) || b < 0 || b > 255)) return null;
    return parts;
  };
  const ipBytes = parseIPv4(ip);
  const prefixBytes = parseIPv4(prefix);
  if (!ipBytes || !prefixBytes) return false;
  const fullBytes = Math.floor(length / 8);
  const remainingBits = length % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== prefixBytes[i]) return false;
  }
  if (remainingBits > 0) {
    const mask = 0xff & (0xff << (8 - remainingBits));
    if ((ipBytes[fullBytes]! & mask) !== (prefixBytes[fullBytes]! & mask)) return false;
  }
  return true;
}

// ── Shell quoting ──────────────────────────────────────────────────────────

function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function sanitizeEnv(env?: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

// ── VM operations factories ────────────────────────────────────────────────

function createVmReadOps(getVm: () => Promise<VM>): ReadOperations {
  return {
    readFile: async (absolutePath) => {
      const vm = await getVm();
      return vm.readFile(absolutePath);
    },
    access: async (absolutePath) => {
      const vm = await getVm();
      const r = await vm.exec(["/bin/sh", "-lc", `test -r ${shQuote(absolutePath)}`]);
      if (!r.ok) {
        throw new Error(`not readable: ${absolutePath}`);
      }
    },
    detectImageMimeType: async (absolutePath) => {
      const vm = await getVm();
      try {
        const r = await vm.exec([
          "/bin/sh",
          "-lc",
          `file --mime-type -b ${shQuote(absolutePath)}`,
        ]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
      } catch {
        return null;
      }
    },
  };
}

function createVmWriteOps(getVm: () => Promise<VM>): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      const vm = await getVm();
      const dir = posix.dirname(absolutePath);
      await vm.exec(["/bin/mkdir", "-p", dir]);
      await vm.writeFile(absolutePath, content, { encoding: "utf8" });
    },
    mkdir: async (dir) => {
      const vm = await getVm();
      const r = await vm.exec(["/bin/mkdir", "-p", dir]);
      if (!r.ok) {
        throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
      }
    },
  };
}

function createVmEditOps(getVm: () => Promise<VM>): EditOperations {
  const readOps = createVmReadOps(getVm);
  const writeOps = createVmWriteOps(getVm);
  return {
    readFile: readOps.readFile,
    access: readOps.access,
    writeFile: writeOps.writeFile,
  };
}

function createVmBashOps(getVm: () => Promise<VM>): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const vm = await getVm();

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              ac.abort();
            }, timeout * 1000)
          : undefined;

      try {
        const proc = vm.exec(["/bin/bash", "-lc", command], {
          cwd,
          signal: ac.signal,
          env: sanitizeEnv(env),
          stdout: "pipe",
          stderr: "pipe",
        });

        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }

        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted", { cause: err });
        if (timedOut) throw new Error(`timeout:${timeout}`, { cause: err });
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface GondolinToolsOptions {
  arc: string;
  config: GondolinConfig;
  logger?: Logger;
}

/**
 * Create read/write/edit/bash tools backed by a Gondolin VM.
 *
 * One VM is created (and cached) per arc.  Each call to this function creates
 * a fresh ephemeral session directory at /tmp/session-{uuid}/ which becomes the
 * default working directory for bash and the base for relative path resolution.
 */
export function createGondolinTools(options: GondolinToolsOptions): MuaddibTool[] {
  const { arc, config, logger } = options;
  const arcId = normalizeArcId(arc);
  const sessionDir = `/tmp/session-${randomUUID().slice(0, 8)}`;

  // Register this session immediately so checkpointGondolinArc knows it is
  // active even before the VM has been started or any tool has been called.
  vmActiveSessions.set(arcId, (vmActiveSessions.get(arcId) ?? 0) + 1);

  let vmReady: Promise<VM> | null = null;

  function getVm(): Promise<VM> {
    if (!vmReady) {
      vmReady = ensureVm(arc, config, logger).then(async (vm) => {
        await vm.exec(["/bin/mkdir", "-p", sessionDir]);
        logger?.info(`Gondolin session dir: ${sessionDir} (arc: ${normalizeArcId(arc)})`);
        return vm;
      });
    }
    return vmReady;
  }

  const piReadTool = createReadTool(sessionDir, { operations: createVmReadOps(getVm) });
  const piWriteTool = createWriteTool(sessionDir, { operations: createVmWriteOps(getVm) });
  const piEditTool = createEditTool(sessionDir, { operations: createVmEditOps(getVm) });
  const piBashTool = createBashTool(sessionDir, { operations: createVmBashOps(getVm) });

  return [
    { ...piReadTool, persistType: "none" } as MuaddibTool,
    { ...piWriteTool, persistType: "none" } as MuaddibTool,
    { ...piEditTool, persistType: "none" } as MuaddibTool,
    { ...piBashTool, persistType: "summary" } as MuaddibTool,
  ];
}

// ── Exported for testing ───────────────────────────────────────────────────

export { isHostBlocked, isIpInCidr };

export function resetGondolinVmCache(): void {
  vmCache.clear();
  vmCacheLocks.clear();
  vmActiveSessions.clear();
}

/**
 * Checkpoint the Gondolin VM for an arc after a session ends.
 *
 * Cleans up ephemeral session directories inside /tmp, then stops the VM and
 * persists its disk state to `$MUADDIB_HOME/workspaces/<arcId>/vm-checkpoint.qcow2`.
 * The VM is removed from the cache so the next invocation resumes from the checkpoint.
 *
 * This is a no-op if no VM is running for the arc.
 */
export async function checkpointGondolinArc(
  arc: string,
  logger?: Logger,
): Promise<void> {
  const arcId = normalizeArcId(arc);

  // Decrement the active session counter for this arc.
  const remaining = Math.max(0, (vmActiveSessions.get(arcId) ?? 0) - 1);
  vmActiveSessions.set(arcId, remaining);

  if (remaining > 0) {
    logger?.debug(`Gondolin arc ${arcId}: ${remaining} session(s) still active, deferring checkpoint`);
    return;
  }

  vmActiveSessions.delete(arcId);
  const vm = vmCache.get(arcId);
  if (!vm) return;

  const checkpointPath = join(getArcWorkspacePath(arc), "vm-checkpoint.qcow2");

  try {
    // Clean ephemeral session dirs from VM /tmp before checkpointing
    await vm.exec(["/bin/sh", "-c", "rm -rf /tmp/session-*"]);
    // Stop the VM and materialize the disk overlay as a checkpoint
    await vm.checkpoint(checkpointPath);
    vmCache.delete(arcId);
    logger?.info(`Gondolin VM checkpointed for arc ${arcId}: ${checkpointPath}`);
  } catch (err) {
    logger?.error(`Gondolin checkpoint failed for arc ${arcId}`, String(err));
    // Remove from cache regardless — a broken VM should not be reused
    vmCache.delete(arcId);
  }
}
