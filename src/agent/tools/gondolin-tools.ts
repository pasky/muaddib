/**
 * Gondolin sandbox integration.
 *
 * Provides read/write/edit/bash tools backed by a Gondolin micro-VM instead of
 * the host filesystem.  One VM per arc (persistent, reused across invocations).
 * Each invocation gets an ephemeral working directory at /tmp/session-{uuid}/.
 * Persistent workspace is mounted from $MUADDIB_HOME/workspaces/<arcId>/ at /workspace.
 * VM disk checkpoint stored at $MUADDIB_HOME/checkpoints/<arcId>.qcow2 (outside the VFS mount).
 *
 * Network policy:
 *   - Internal RFC-1918 and loopback ranges are blocked by default.
 *   - Hostname from tools.artifacts.url is exempt from that internal-range block
 *     so the agent can fetch shared artifacts even when hosted on private IPs.
 *   - Additional blocked CIDR ranges are taken from config.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
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
import type { ToolsConfig } from "../../config/muaddib-config.js";
import type { Logger } from "../../app/logging.js";
import type { ChronicleStore } from "../../chronicle/chronicle-store.js";
import type { ArtifactContext, MuaddibTool, ToolSet } from "./types.js";
import {
  createShareArtifactTool,
  createDefaultShareArtifactExecutor,
  type SandboxReadFile,
} from "./artifact.js";
import {
  loadBundledSkills,
  formatSkillsForVmPrompt,
  VM_SKILLS_BASE,
  type LoadedSkill,
} from "../skills/load-skills.js";

// ── Arc ID / workspace path / checkpoint path ──────────────────────────────
// Arc IDs are already filesystem-safe (percent-encoded at construction in
// roomArc / fsSafeArc).  No further normalisation needed here.

export function getArcWorkspacePath(arc: string): string {
  return join(getMuaddibHome(), "workspaces", arc);
}

/** Checkpoint file lives *outside* the VFS-mounted workspace so the VM cannot tamper with it. */
export function getArcCheckpointPath(arc: string): string {
  return join(getMuaddibHome(), "checkpoints", arc + ".qcow2");
}

// ── VM cache: one VM per arc ───────────────────────────────────────────────

/** Close all cached VMs. Exported for testing and used by process exit handlers. */
export async function closeAllVms(): Promise<void> {
  const vmCount = vmCache.size;
  const vms = [...vmCache.values()];
  vmCache.clear();
  await Promise.allSettled(vms.map((vm) => vm.close().catch(() => {})));
  // Release one slot per VM that was running so waiting callers can proceed.
  for (let i = 0; i < vmCount; i++) {
    releaseVmSlot();
  }
}

function installProcessCleanupHandlers() {
  let cleanupDone = false;

  const asyncCleanup = async (signal: string) => {
    if (cleanupDone) return;
    cleanupDone = true;
    await closeAllVms();
    // Remove our handlers before re-raising so the default handler fires
    // instead of being caught again by our listener (which would swallow it).
    process.removeListener("SIGTERM", sigtermHandler);
    process.removeListener("SIGINT", sigintHandler);
    process.kill(process.pid, signal as NodeJS.Signals);
  };

  const sigintHandler = () => void asyncCleanup("SIGINT");
  const sigtermHandler = () => void asyncCleanup("SIGTERM");

  process.on("SIGTERM", sigtermHandler);
  process.on("SIGINT", sigintHandler);

  // 'exit' handler must be synchronous — best-effort: destroy VMs synchronously
  // if they expose a sync path (close() is async, so we can only attempt it).
  process.on("exit", () => {
    for (const vm of vmCache.values()) {
      try {
        // Fire-and-forget: the process is exiting, but this may still kill
        // the child QEMU process if close() initiates the kill synchronously.
        vm.close().catch(() => {});
      } catch {
        // ignore
      }
    }
    vmCache.clear();
  });
}

installProcessCleanupHandlers();

const vmCache = new Map<string, VM>();
const vmCacheLocks = new Map<string, Promise<VM>>();
/** Active session count per arcId — prevents checkpointing while another session is still running. */
const vmActiveSessions = new Map<string, number>();
/** In-flight checkpoint promise per arcId — prevents concurrent writes to the same .qcow2 file. */
const vmCheckpointInProgress = new Map<string, Promise<void>>();

// ── Global QEMU concurrency semaphore ──────────────────────────────────────

/**
 * Current maximum number of simultaneously running arc VMs.
 * Undefined until the first VM is created (limit is taken from the first config seen).
 * All subsequent VM creations must agree with this value — mismatches throw.
 */
let vmSlotLimit: number | undefined = undefined;
/** How many arc VMs are currently running (held slots). */
let vmSlotActive = 0;
/** Resolve callbacks for callers waiting to acquire a slot. */
const vmSlotWaiters: Array<() => void> = [];

function resolveVmSlotLimit(value: unknown): number {
  if (value === undefined || value === null) return 8;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(
      `agent.tools.gondolin.maxConcurrentVms must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return value as number;
}

/** Block until a QEMU slot is available, then claim it. */
async function acquireVmSlot(limit: number): Promise<void> {
  if (vmSlotLimit === undefined) {
    vmSlotLimit = limit;
  } else if (vmSlotLimit !== limit) {
    throw new Error(
      `agent.tools.gondolin.maxConcurrentVms conflict: limit is already set to ${vmSlotLimit}, cannot change to ${limit} at runtime`,
    );
  }
  if (vmSlotActive < vmSlotLimit) {
    vmSlotActive++;
    return;
  }
  await new Promise<void>((resolve) => vmSlotWaiters.push(resolve));
  vmSlotActive++;
}

/** Release a previously acquired QEMU slot and wake the next waiter if any. */
function releaseVmSlot(): void {
  vmSlotActive = Math.max(0, vmSlotActive - 1);
  const waiter = vmSlotWaiters.shift();
  if (waiter) waiter();
}

type SupportedDnsMode = NonNullable<GondolinConfig["dnsMode"]>;

function resolveDnsMode(dnsMode: unknown): SupportedDnsMode {
  if (dnsMode === undefined) return "synthetic";
  if (dnsMode === "open" || dnsMode === "synthetic") return dnsMode;
  if (dnsMode === "trusted") {
    throw new Error(
      "agent.tools.gondolin.dnsMode=\"trusted\" is no longer supported; use \"synthetic\" or \"open\"",
    );
  }
  throw new Error(
    `Invalid agent.tools.gondolin.dnsMode: ${JSON.stringify(dnsMode)} (expected "synthetic" or "open")`,
  );
}

async function ensureVm(
  arc: string,
  config: GondolinConfig,
  dnsMode: SupportedDnsMode,
  skills: LoadedSkill[],
  chronicleFiles: Array<{ filename: string; content: string }>,
  artifactHostname: string | undefined,
  logger?: Logger,
): Promise<VM> {
  // If a checkpoint is in progress for this arc, wait for it to complete before
  // creating or returning a VM.  The checkpointing operation removes the VM from
  // vmCache immediately, so after the await the cache miss below will trigger a
  // fresh VM creation — preventing callers from operating on a VM that is being
  // shut down and checkpointed.
  const pendingCheckpoint = vmCheckpointInProgress.get(arc);
  if (pendingCheckpoint) {
    await pendingCheckpoint;
  }

  const cached = vmCache.get(arc);
  if (cached) return cached;

  const pending = vmCacheLocks.get(arc);
  if (pending) return pending;

  const createPromise = (async () => {
    const slotLimit = resolveVmSlotLimit(config.maxConcurrentVms);
    await acquireVmSlot(slotLimit);

    let slotAcquired = true;
    try {
      const {
        VM: VMClass,
        VmCheckpoint,
        RealFSProvider,
        MemoryProvider: MemProviderClass,
        createHttpHooks,
      } = await import("@earendil-works/gondolin");

      if (!process.env.GONDOLIN_GUEST_DIR) {
        const customImageDir = join(getMuaddibHome(), "gondolin-image");
        if (existsSync(customImageDir)) {
          process.env.GONDOLIN_GUEST_DIR = customImageDir;
        }
      }

      const workspacePath = getArcWorkspacePath(arc);
      mkdirSync(workspacePath, { recursive: true });
      mkdirSync(join(getMuaddibHome(), "checkpoints"), { recursive: true });

      const blockedCidrs = config.blockedCidrs ?? [];

      const { httpHooks } = createHttpHooks({
        // We implement internal-range blocking ourselves so tools.artifacts.url
        // hostname can bypass that check while preserving the same default block.
        blockInternalRanges: false,
        isIpAllowed: (info) => {
          const isArtifactHostname =
            artifactHostname !== undefined && info.hostname.toLowerCase() === artifactHostname;

          if (!isArtifactHostname && isInternalHttpBlockedIp(info.ip)) {
            return false;
          }

          if (blockedCidrs.length === 0) return true;
          return !blockedCidrs.some((cidr) => isIpInCidr(info.ip, cidr));
        },
      });

      // Serve bundled skills as a readonly in-memory mount so the agent can
      // read them via the sandbox read tool without any file-copy overhead.
      const mounts: Record<string, import("@earendil-works/gondolin").VirtualProvider> = {
        "/workspace": new RealFSProvider(workspacePath),
      };
      if (skills.length > 0) {
        const skillsFs = new MemProviderClass();
        for (const skill of skills) {
          skillsFs.mkdirSync(`${skill.name}`, { recursive: true });
          // MemoryProvider always implements writeFileSync; the optional typing
          // comes from VirtualProvider's base interface.
          skillsFs.writeFileSync!(`${skill.name}/SKILL.md`, skill.content, { encoding: "utf8" });
        }
        skillsFs.setReadOnly();
        mounts[VM_SKILLS_BASE] = skillsFs;
      }

      if (chronicleFiles.length > 0) {
        const chronicleFs = new MemProviderClass();
        for (const file of chronicleFiles) {
          chronicleFs.writeFileSync!(file.filename, file.content, { encoding: "utf8" });
        }
        chronicleFs.setReadOnly();
        mounts["/chronicle"] = chronicleFs;
      }

      // Forward QEMU serial console output (guest kernel + init messages) to
      // the logger so stuck boots are diagnosable.  The "qemu" debug component
      // requires the "protocol" debug flag.
      const debugLog: import("@earendil-works/gondolin").DebugLogFn = (component, message) => {
        logger?.debug(`Gondolin VM [${arc}] ${component}: ${message}`);
      };

      const vmOptions: import("@earendil-works/gondolin").VMOptions = {
        vfs: { mounts },
        httpHooks,
        dns: { mode: dnsMode },
        sandbox: { debug: ["protocol"] },
        debugLog,
      };

      const checkpointPath = getArcCheckpointPath(arc);
      let vm: import("@earendil-works/gondolin").VM;
      if (existsSync(checkpointPath)) {
        try {
          const checkpoint = VmCheckpoint.load(checkpointPath);
          vm = await checkpoint.resume(vmOptions);
          logger?.info(`Gondolin VM resumed from checkpoint for arc ${arc}: ${checkpointPath}`);
          // Health check: verify the guest is actually responsive after resume.
          // QEMU can boot from a dirty checkpoint and spin at 100% CPU without
          // ever starting sandboxd, leaving all subsequent operations stuck.
          await vm.exec(["/bin/true"], { signal: AbortSignal.timeout(VM_HEALTH_CHECK_TIMEOUT_MS) });
          logger?.info(`Gondolin VM health check passed for arc ${arc}`);
        } catch (err) {
          logger?.warn(`Gondolin checkpoint resume/health-check failed for arc ${arc}, deleting checkpoint and starting fresh VM`, String(err));
          // Clean up the broken VM if it was created.
          try { vm!.close().catch(() => {}); } catch { /* ignore */ }
          try { unlinkSync(checkpointPath); } catch { /* ignore */ }
          vm = await VMClass.create(vmOptions);
          logger?.info(`Gondolin VM started fresh (after checkpoint failure) for arc ${arc}, workspace: ${workspacePath}`);
        }
      } else {
        vm = await VMClass.create(vmOptions);
        logger?.info(`Gondolin VM started for arc ${arc}, workspace: ${workspacePath}`);
      }

      vmCache.set(arc, vm);
      slotAcquired = false; // slot is now owned by the VM lifetime, released on checkpoint/close
      return vm;
    } finally {
      if (slotAcquired) {
        // VM creation failed — release the slot so waiters can proceed.
        releaseVmSlot();
      }
    }
  })();

  vmCacheLocks.set(arc, createPromise);
  try {
    const vm = await createPromise;
    return vm;
  } finally {
    vmCacheLocks.delete(arc);
  }
}

// ── Network filtering helpers ──────────────────────────────────────────────

const INTERNAL_HTTP_BLOCKED_CIDRS = [
  // IPv4
  "0.0.0.0/8",
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "255.0.0.0/8",
  // IPv6
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
] as const;

function extractIPv4MappedIp(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const mapped = ip.slice("::ffff:".length);
  return mapped.includes(".") ? mapped : null;
}

function isInternalHttpBlockedIp(ip: string): boolean {
  if (INTERNAL_HTTP_BLOCKED_CIDRS.some((cidr) => isIpInCidr(ip, cidr))) {
    return true;
  }

  const mappedIpv4 = extractIPv4MappedIp(ip);
  if (!mappedIpv4) return false;
  return INTERNAL_HTTP_BLOCKED_CIDRS.some((cidr) => isIpInCidr(mappedIpv4, cidr));
}

function resolveArtifactHostname(artifactsUrl: string | undefined, logger?: Logger): string | undefined {
  if (!artifactsUrl) return undefined;
  try {
    return new URL(artifactsUrl).hostname.toLowerCase();
  } catch (err) {
    logger?.warn(
      `Ignoring invalid tools.artifacts.url for Gondolin HTTP allowlist: ${artifactsUrl}`,
      String(err),
    );
    return undefined;
  }
}

function parseCidrPrefixLength(rawLength: string, maxLength: number): number | null {
  if (!/^\d+$/.test(rawLength)) return null;
  const prefixLength = Number(rawLength);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > maxLength) return null;
  return prefixLength;
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const slashIdx = cidr.lastIndexOf("/");
  if (slashIdx === -1) return false;
  const prefix = cidr.slice(0, slashIdx);
  const rawLength = cidr.slice(slashIdx + 1);

  if (prefix.includes(":") && ip.includes(":")) {
    const prefixLength = parseCidrPrefixLength(rawLength, 128);
    if (prefixLength === null) return false;
    return isIPv6InPrefix(ip, prefix, prefixLength);
  }
  if (!prefix.includes(":") && !ip.includes(":")) {
    const prefixLength = parseCidrPrefixLength(rawLength, 32);
    if (prefixLength === null) return false;
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

// ── Output cap ────────────────────────────────────────────────────────────

/**
 * Maximum bytes forwarded from VM bash output to the upstream bash tool.
 *
 * The upstream pi bash tool (createBashTool) writes full output to a host
 * /tmp/pi-bash-*.log file and appends that path to the response when output
 * exceeds its DEFAULT_MAX_BYTES limit (50 KB).  In Gondolin mode the agent
 * cannot read that host path through the VM's read tool, and exposing it
 * leaks host filesystem details into the agent's context.
 *
 * By capping what we deliver via onData to strictly below 50 KB, we ensure
 * the upstream tool's temp-file branch is never triggered.  When the cap is
 * hit we append a VM-specific truncation notice in place of the host path.
 */
const VM_BASH_OUTPUT_CAP_BYTES = 48 * 1024; // 48 KB — below upstream's 50 KB threshold

const VM_HEALTH_CHECK_TIMEOUT_MS = 20_000;

// ── Bundled skills (loaded once, installed into every VM) ──────────────────

let cachedSkills: LoadedSkill[] | undefined;

function getBundledSkills(): LoadedSkill[] {
  if (!cachedSkills) {
    cachedSkills = loadBundledSkills();
  }
  return cachedSkills;
}

// ── VM operations factories ────────────────────────────────────────────────

function createVmReadOps(getVm: () => Promise<VM>, opTimeoutMs: number, logger?: Logger): ReadOperations {
  return {
    readFile: async (absolutePath) => {
      const vm = await getVm();
      return vm.readFile(absolutePath, { signal: AbortSignal.timeout(opTimeoutMs) });
    },
    access: async (absolutePath) => {
      const vm = await getVm();
      const r = await vm.exec(["/bin/sh", "-lc", `test -r ${shQuote(absolutePath)}`], {
        signal: AbortSignal.timeout(opTimeoutMs),
      });
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
        ], { signal: AbortSignal.timeout(opTimeoutMs) });
        if (!r.ok) {
          logger?.warn(`Gondolin detectImageMimeType: 'file' failed for ${absolutePath} (exit ${r.exitCode}): ${r.stderr}`);
          return null;
        }
        const m = r.stdout.trim();
        const supported = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m);
        if (!supported && m.startsWith("image/")) {
          logger?.info(`Gondolin detectImageMimeType: unsupported image MIME type '${m}' for ${absolutePath}`);
        }
        return supported ? m : null;
      } catch (err) {
        logger?.warn(`Gondolin detectImageMimeType: exception for ${absolutePath}`, String(err));
        return null;
      }
    },
  };
}

function createVmWriteOps(getVm: () => Promise<VM>, opTimeoutMs: number): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      const vm = await getVm();
      const dir = posix.dirname(absolutePath);
      await vm.exec(["/bin/mkdir", "-p", dir], { signal: AbortSignal.timeout(opTimeoutMs) });
      await vm.writeFile(absolutePath, content, { encoding: "utf8", signal: AbortSignal.timeout(opTimeoutMs) });
    },
    mkdir: async (dir) => {
      const vm = await getVm();
      const r = await vm.exec(["/bin/mkdir", "-p", dir], { signal: AbortSignal.timeout(opTimeoutMs) });
      if (!r.ok) {
        throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
      }
    },
  };
}

function createVmEditOps(getVm: () => Promise<VM>, opTimeoutMs: number, logger?: Logger): EditOperations {
  const readOps = createVmReadOps(getVm, opTimeoutMs, logger);
  const writeOps = createVmWriteOps(getVm, opTimeoutMs);
  return {
    readFile: readOps.readFile,
    access: readOps.access,
    writeFile: writeOps.writeFile,
  };
}

function createVmBashOps(getVm: () => Promise<VM>, defaultTimeoutSeconds: number): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const vm = await getVm();

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      // Apply default timeout when caller supplies none; cap caller-supplied
      // timeouts so no bash command can run indefinitely inside the VM.
      const effectiveTimeout =
        timeout && timeout > 0
          ? Math.min(timeout, defaultTimeoutSeconds)
          : defaultTimeoutSeconds;

      let timedOut = false;
      const timer =
        effectiveTimeout > 0
          ? setTimeout(() => {
              timedOut = true;
              ac.abort();
            }, effectiveTimeout * 1000)
          : undefined;

      try {
        const proc = vm.exec(["/bin/bash", "-lc", command], {
          cwd,
          signal: ac.signal,
          stdout: "pipe",
          stderr: "pipe",
        });

        let totalBytes = 0;
        let capped = false;
        for await (const chunk of proc.output()) {
          if (capped) {
            // Drain remaining chunks so the process can finish naturally.
            continue;
          }
          const data = chunk.data;
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          const newTotal = totalBytes + buf.length;
          if (newTotal > VM_BASH_OUTPUT_CAP_BYTES) {
            const remaining = VM_BASH_OUTPUT_CAP_BYTES - totalBytes;
            if (remaining > 0) {
              onData(buf.subarray(0, remaining));
            }
            onData(
              Buffer.from(
                `\n[output truncated — VM stream capped at ${VM_BASH_OUTPUT_CAP_BYTES / 1024}KB]\n`,
              ),
            );
            capped = true;
          } else {
            totalBytes = newTotal;
            onData(data);
          }
        }

        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted", { cause: err });
        if (timedOut) throw new Error(`timeout:${effectiveTimeout}`, { cause: err });
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
  toolsConfig?: ToolsConfig;
  chronicleStore?: ChronicleStore;
  logger?: Logger;
}

/**
 * Create read/write/edit/bash tools backed by a Gondolin VM, plus a dispose
 * callback that must be called (via SessionRunner's onSessionEnd) when the
 * session ends — whether it succeeds or fails.
 *
 * One VM is created (and cached) per arc.  Each call to this function creates
 * a fresh ephemeral session directory at /tmp/session-{uuid}/ which becomes the
 * default working directory for bash and the base for relative path resolution.
 */
export function createGondolinTools(options: GondolinToolsOptions): ToolSet {
  const { arc, config, toolsConfig, logger } = options;
  const dnsMode = resolveDnsMode(config.dnsMode);
  const sessionDir = `/tmp/session-${randomUUID().slice(0, 8)}`;

  // Ensure the workspace directory exists and stamp the arc name into it so
  // external tools (e.g. scripts/gondolin-shell.sh) can identify which arc
  // owns a given workspace ID.  Written eagerly on every attach so the file
  // stays current even if the arc name was never recorded before.
  const workspacePath = getArcWorkspacePath(arc);
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(workspacePath, ".arc-name"), arc, "utf8");

  // Register this session immediately so checkpointGondolinArc knows it is
  // active even before the VM has been started or any tool has been called.
  vmActiveSessions.set(arc, (vmActiveSessions.get(arc) ?? 0) + 1);

  const skills = getBundledSkills();
  const chronicleFiles = options.chronicleStore?.readAllChapterFiles(arc) ?? [];
  const artifactHostname = resolveArtifactHostname(toolsConfig?.artifacts?.url, logger);

  const bashTimeoutSeconds = config.bashTimeoutSeconds ?? 270;
  const vmOpTimeoutMs = bashTimeoutSeconds * 1000;

  let vmReady: Promise<VM> | null = null;

  function getVm(): Promise<VM> {
    if (!vmReady) {
      vmReady = ensureVm(arc, config, dnsMode, skills, chronicleFiles, artifactHostname, logger).then(async (vm) => {
        await vm.exec(["/bin/mkdir", "-p", sessionDir], { signal: AbortSignal.timeout(vmOpTimeoutMs) });
        logger?.info(`Gondolin session dir: ${sessionDir} (arc: ${arc})`);
        return vm;
      });
    }
    return vmReady;
  }

  const piReadTool = createReadTool(sessionDir, { operations: createVmReadOps(getVm, vmOpTimeoutMs, logger) });
  const piWriteTool = createWriteTool(sessionDir, { operations: createVmWriteOps(getVm, vmOpTimeoutMs) });
  const piEditTool = createEditTool(sessionDir, { operations: createVmEditOps(getVm, vmOpTimeoutMs, logger) });
  const piBashTool = createBashTool(sessionDir, { operations: createVmBashOps(getVm, bashTimeoutSeconds) });

  // share_artifact reads files from the VM and publishes them to the artifact store.
  const sandboxReadFile: SandboxReadFile = async (absolutePath: string): Promise<Buffer> => {
    const vm = await getVm();
    const content = await vm.readFile(absolutePath, { signal: AbortSignal.timeout(vmOpTimeoutMs) });
    return Buffer.isBuffer(content) ? content : Buffer.from(content);
  };
  const artifactContext: ArtifactContext = { toolsConfig, logger };
  const shareArtifactExecutor = createDefaultShareArtifactExecutor(artifactContext, sandboxReadFile);
  const shareArtifactTool = createShareArtifactTool({ shareArtifact: shareArtifactExecutor });

  const tools: MuaddibTool[] = [
    { ...piReadTool, persistType: "none" } as MuaddibTool,
    { ...piWriteTool, persistType: "none" } as MuaddibTool,
    { ...piEditTool, persistType: "none" } as MuaddibTool,
    { ...piBashTool, persistType: "summary" } as MuaddibTool,
    shareArtifactTool,
  ];

  const skillsSection = formatSkillsForVmPrompt(skills);
  const artifactsUrl = options.toolsConfig?.artifacts?.url;
  const artifactsSuffix = artifactsUrl
    ? ` Artifacts: your previously produced output attachments - any URLs that start with ${artifactsUrl}, read with download_artifact skill.`
    : "";
  const chronicleSuffix = chronicleFiles.length > 0
    ? " Chronicle: your memory chapters are at /chronicle/ (read-only)."
    : "";
  const systemPromptSuffix =
    `Filesystem: /workspace persists across sessions; ${sessionDir} is your ephemeral working directory.` +
    chronicleSuffix +
    artifactsSuffix +
    skillsSection;

  const dispose = () => checkpointGondolinArc(arc, logger);

  return { tools, dispose, systemPromptSuffix };
}

// ── Exported for testing ───────────────────────────────────────────────────

export { isIpInCidr };

/** Returns current semaphore state — for tests only. */
export function getVmSlotState(): { active: number; limit: number | undefined; waiters: number } {
  return { active: vmSlotActive, limit: vmSlotLimit, waiters: vmSlotWaiters.length };
}

export function resetGondolinVmCache(): void {
  vmCache.clear();
  vmCacheLocks.clear();
  vmActiveSessions.clear();
  vmCheckpointInProgress.clear();
  // Reset semaphore state — unblock any waiters left from previous tests.
  vmSlotActive = 0;
  vmSlotLimit = undefined;
  vmSlotWaiters.splice(0);
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
  // Decrement the active session counter for this arc.
  const current = vmActiveSessions.get(arc) ?? 0;
  if (current <= 0) {
    // More checkpointGondolinArc calls than createGondolinTools — programming error.
    logger?.warn(`Gondolin arc ${arc}: checkpointGondolinArc called with no active sessions registered; ignoring`);
    return;
  }
  const remaining = current - 1;
  vmActiveSessions.set(arc, remaining);

  if (remaining > 0) {
    logger?.debug(`Gondolin arc ${arc}: ${remaining} session(s) still active, deferring checkpoint`);
    return;
  }

  vmActiveSessions.delete(arc);
  const vm = vmCache.get(arc);
  if (!vm) return;

  // Serialize concurrent checkpoint attempts for the same arc.  This can only
  // be reached if the caller somehow triggers two simultaneous end-of-session
  // paths (e.g. a retry after a transient error).  Without this guard both
  // calls would race to overwrite the same .qcow2 file.
  const inFlight = vmCheckpointInProgress.get(arc);
  if (inFlight) {
    logger?.debug(`Gondolin arc ${arc}: checkpoint already in progress, waiting`);
    return inFlight;
  }

  const checkpointPath = getArcCheckpointPath(arc);

  // Remove from cache immediately so concurrent ensureVm() calls for this arc
  // don't reuse a VM that is being shut down / checkpointed.  ensureVm() waits
  // for vmCheckpointInProgress to settle before creating a replacement VM.
  vmCache.delete(arc);

  const checkpointPromise = (async () => {
    try {
      // Clean ephemeral session dirs from VM /tmp before checkpointing
      await vm.exec(["/bin/sh", "-c", "rm -rf /tmp/session-*"]);
      // Stop the VM and materialize the disk overlay as a checkpoint
      await vm.checkpoint(checkpointPath);
      logger?.info(`Gondolin VM checkpointed for arc ${arc}: ${checkpointPath}`);
    } catch (err) {
      logger?.error(`Gondolin checkpoint failed for arc ${arc}`, String(err));
      // VM was already removed from cache above; close the QEMU process so it
      // doesn't leak as an orphan.
      await vm.close().catch(() => {});
    } finally {
      vmCheckpointInProgress.delete(arc);
      // Release the concurrency slot so waiting arcs can proceed.
      releaseVmSlot();
    }
  })();

  vmCheckpointInProgress.set(arc, checkpointPromise);
  return checkpointPromise;
}
