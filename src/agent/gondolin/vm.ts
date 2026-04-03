/**
 * Gondolin VM lifecycle: cache, concurrency slots, creation, checkpoint,
 * close, process-cleanup handlers, and the operation bridges that adapt
 * pi-coding-agent's Read/Write/Edit/BashOperations to a Gondolin VM.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";

import type {
  AuthStorage,
  BashOperations,
  EditOperations,
  ReadOperations,
  WriteOperations,
} from "@mariozechner/pi-coding-agent";
import type { HttpFetch, VM } from "@earendil-works/gondolin";

import type { GondolinConfig } from "../../config/muaddib-config.js";
import type { Logger } from "../../app/logging.js";
import type { ArcEventsWatcher } from "../../events/watcher.js";
import { loadBundledSkills } from "../skills/load-skills.js";
import { getArcWorkspacePath, getArcCheckpointPath, createVmMounts } from "./fs.js";
import { createVmHttpHooks } from "./network.js";
import { resolveGondolinEnv } from "./env.js";
import { getMuaddibHome } from "../../config/paths.js";
import { resolveLocalArtifactFilePath } from "../tools/url-utils.js";

// ── VM cache: one VM per arc ───────────────────────────────────────────────

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

export function resolveVmSlotLimit(value: unknown): number {
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

// ── Config helpers ─────────────────────────────────────────────────────────

export type SupportedDnsMode = NonNullable<GondolinConfig["dnsMode"]>;

export function resolveDnsMode(dnsMode: unknown): SupportedDnsMode {
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

// ── Constants ──────────────────────────────────────────────────────────────

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

// ── Shell quoting ──────────────────────────────────────────────────────────

export function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function rewriteMissingQemuBinaryError(error: unknown): Error | null {
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : undefined;
  if (code !== "ENOENT") return null;

  const path = typeof (error as { path?: unknown })?.path === "string"
    ? (error as { path: string }).path
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const binary = path?.includes("qemu") ? path : message.match(/\b(qemu[\w.-]*)\b/)?.[1];
  if (!binary) return null;

  return new Error(
    `Missing host dependency '${binary}' required by Muaddib's Gondolin sandbox. Install QEMU on the host (Debian/Ubuntu: sudo apt install qemu-system qemu-utils; macOS: brew install qemu) and ensure '${binary}' is on PATH.`,
    { cause: error },
  );
}

function inferDiskFormatFromPath(diskPath: string): "raw" | "qcow2" {
  const lower = diskPath.toLowerCase();
  return lower.endsWith(".qcow2") || lower.endsWith(".qcow") ? "qcow2" : "raw";
}

type QemuImgInfo = Record<string, unknown>;

function qemuImgInfoJson(imagePath: string): QemuImgInfo {
  const raw = execFileSync("qemu-img", ["info", "--output=json", imagePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(raw) as QemuImgInfo;
}

function extractBackingFilename(info: Record<string, any>): string | null {
  if (typeof info["backing-filename"] === "string") {
    return info["backing-filename"];
  }

  const formatSpecific = info["format-specific"] as { data?: Record<string, unknown> } | undefined;
  if (typeof formatSpecific?.data?.["backing-filename"] === "string") {
    return formatSpecific.data["backing-filename"] as string;
  }

  return null;
}

function resolveQcow2BackingPath(imagePath: string): string | null {
  const backing = extractBackingFilename(qemuImgInfoJson(imagePath));
  if (!backing) return null;
  return isAbsolute(backing) ? resolve(backing) : resolve(dirname(imagePath), backing);
}

/**
 * Read the raw gondolin checkpoint trailer bytes from the end of a qcow2 file.
 *
 * Gondolin appends `[json][8-byte magic "GONDCPT1"][u64be json-length]` after
 * the qcow2 image data.  qemu-img ignores these trailing bytes, but
 * `qemu-img rebase` allocates new clusters at the end of the file and
 * overwrites them.  This helper extracts the full trailer so it can be
 * re-appended after a rebase.
 */
function extractCheckpointTrailerBytes(filePath: string): Buffer | null {
  const MAGIC = Buffer.from("GONDCPT1"); // 8 bytes
  const FOOTER_SIZE = 16; // magic(8) + u64be(8)

  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < FOOTER_SIZE) return null;

    const footer = Buffer.alloc(FOOTER_SIZE);
    readSync(fd, footer, 0, FOOTER_SIZE, size - FOOTER_SIZE);
    if (!footer.subarray(0, 8).equals(MAGIC)) return null;

    const jsonLen = Number(footer.readBigUInt64BE(8));
    const totalTrailerLen = jsonLen + FOOTER_SIZE;
    const trailerStart = size - totalTrailerLen;
    if (trailerStart < 0) return null;

    const trailer = Buffer.alloc(totalTrailerLen);
    readSync(fd, trailer, 0, totalTrailerLen, trailerStart);
    return trailer;
  } finally {
    closeSync(fd);
  }
}

function safeRebaseQcow2InPlace(imagePath: string, backingPath: string): void {
  execFileSync(
    "qemu-img",
    ["rebase", "-F", inferDiskFormatFromPath(backingPath), "-b", backingPath, imagePath],
    { stdio: "ignore" },
  );
}

async function checkpointVmWithOverwriteWorkaround(
  arc: string,
  vm: VM,
  checkpointPath: string,
  logger?: Logger,
): Promise<void> {
  const resolvedCheckpointPath = resolve(checkpointPath);
  const stagingDir = join(dirname(resolvedCheckpointPath), `.checkpoint-staging-${randomUUID().slice(0, 8)}`);
  const stagedCheckpointPath = join(stagingDir, basename(resolvedCheckpointPath));
  const hadExistingCheckpoint = existsSync(resolvedCheckpointPath);

  mkdirSync(stagingDir, { recursive: true });

  let published = false;
  try {
    await vm.checkpoint(stagedCheckpointPath);

    if (hadExistingCheckpoint) {
      const stagedBacking = resolveQcow2BackingPath(stagedCheckpointPath);
      if (stagedBacking === resolvedCheckpointPath) {
        const desiredBacking = resolveQcow2BackingPath(resolvedCheckpointPath);
        if (!desiredBacking) {
          throw new Error(
            `Muaddib checkpoint workaround could not determine the existing checkpoint backing file for ${resolvedCheckpointPath}`,
          );
        }
        logger?.debug(
          `Gondolin checkpoint workaround: rebasing staged checkpoint for arc ${arc} from ${resolvedCheckpointPath} to ${desiredBacking}`,
        );
        // qemu-img rebase allocates new clusters at the end of the file,
        // which overwrites the gondolin checkpoint trailer.  Save it
        // before rebase and re-append afterwards.
        const trailerBytes = extractCheckpointTrailerBytes(stagedCheckpointPath);
        safeRebaseQcow2InPlace(stagedCheckpointPath, desiredBacking);
        if (trailerBytes) {
          writeFileSync(stagedCheckpointPath, trailerBytes, { flag: "a" });
        }
      }
    }

    renameSync(stagedCheckpointPath, resolvedCheckpointPath);
    published = true;
  } finally {
    if (!published) {
      try {
        unlinkSync(stagedCheckpointPath);
      } catch {
        // ignore
      }
    }
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function createVmFetch(
  artifactsPath: string | undefined,
  artifactsUrl: string | undefined,
  upstreamFetch: HttpFetch,
): HttpFetch {
  return async (input, init) => {
    const url = typeof input === "string"
      ? input
      : ("url" in input && typeof input.url === "string")
          ? input.url
          : String(input);

    try {
      const filePath = resolveLocalArtifactFilePath(url, artifactsUrl, artifactsPath);
      if (!filePath) {
        return upstreamFetch(input, init);
      }

      const requestMethod = init?.method ?? (
        typeof input === "object" && input !== null && "method" in input && typeof input.method === "string"
          ? input.method
          : "GET"
      );
      const method = requestMethod.toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        return new Response(`Method ${method} Not Allowed`, {
          status: 405,
          statusText: "Method Not Allowed",
        }) as any;
      }

      const data = await readFile(filePath);
      return new Response(method === "HEAD" ? null : data, {
        status: 200,
        statusText: "OK",
        headers: {
          "content-length": String(data.length),
          "content-type": "application/octet-stream",
        },
      }) as any;
    } catch (error) {
      if (error instanceof Error && error.message === "Path traversal detected") {
        return new Response("Forbidden", { status: 403, statusText: "Forbidden" }) as any;
      }

      const code = typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : undefined;
      if (code === "EACCES" || code === "EPERM") {
        return new Response("Forbidden", { status: 403, statusText: "Forbidden" }) as any;
      }
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
        return new Response("Not Found", { status: 404, statusText: "Not Found" }) as any;
      }
      throw error;
    }
  };
}

// ── VM creation ────────────────────────────────────────────────────────────

async function ensureVm(opts: VmSessionOptions): Promise<VM> {
  const { arc, serverTag, channelName, config, authStorage, logger, eventsWatcher } = opts;
  const dnsMode = resolveDnsMode(config.dnsMode);
  const skills = loadBundledSkills();
  const artifactsPath = opts.artifactsPath;
  const artifactsUrl = opts.artifactsUrl;
  // If a checkpoint is in progress for this arc, wait for it to complete before
  // creating or returning a VM.
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
      const { VM: VMClass, VmCheckpoint } = await import("@earendil-works/gondolin");

      if (!process.env.GONDOLIN_GUEST_DIR) {
        const customImageDir = getMuaddibHome() + "/gondolin-image";
        if (existsSync(customImageDir)) {
          process.env.GONDOLIN_GUEST_DIR = customImageDir;
        }
      }

      const workspacePath = getArcWorkspacePath(arc);

      const { plainEnv, secretEnv, urlAllowRegexes } = await resolveGondolinEnv({
        config,
        serverTag,
        channelName,
        authStorage,
      });

      const { httpHooks, env: placeholderEnv, fetch: networkFetch } = await createVmHttpHooks({
        arc,
        blockedCidrs: config.blockedCidrs ?? [],
        artifactsUrl,
        autoApproveRegexes: urlAllowRegexes,
        secrets: secretEnv,
        logger,
      });

      const mounts = await createVmMounts({
        arc,
        workspacePath,
        workspaceSizeMb: config.workspaceSizeMb ?? 4096,
        skills,
        eventsWatcher,
        logger,
      });

      // Forward QEMU serial console output (guest kernel + init messages) to
      // the logger so stuck boots are diagnosable.
      const debugLog: import("@earendil-works/gondolin").DebugLogFn = (component, message) => {
        logger?.debug(`Gondolin VM [${arc}] ${component}: ${message}`);
      };

      const combinedEnv = {
        // NOTE: HOME, PATH, VIRTUAL_ENV are intentionally NOT set here —
        // they are baked into /etc/profile.d/gondolin-image-env.sh by the
        // image build config (scripts/build-gondolin-image.sh), which is
        // sourced after Alpine's /etc/profile PATH clobber.
        ...plainEnv,
        ...placeholderEnv,
      };

      // Resolve the guest image directory so we can pass it explicitly via
      // sandbox.imagePath.  This is required for checkpoint resume: gondolin
      // compares the manifest buildId of the provided imagePath against the
      // checkpoint's stored buildId and throws on mismatch, which lets us
      // detect stale checkpoints and start fresh.  Without imagePath, gondolin
      // falls back to scanning its cache by buildId and may silently resume
      // from an outdated cached image even when the custom image has changed.
      const guestDir = process.env.GONDOLIN_GUEST_DIR;

      const vmOptions: import("@earendil-works/gondolin").VMOptions = {
        vfs: { mounts },
        fetch: createVmFetch(artifactsPath, artifactsUrl, networkFetch),
        httpHooks,
        ...(Object.keys(combinedEnv).length > 0 ? { env: combinedEnv } : {}),
        dns: { mode: dnsMode },
        sandbox: { debug: ["protocol"], ...(guestDir ? { imagePath: guestDir } : {}) },
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
          await vm.exec(["/bin/true"], { signal: AbortSignal.timeout(VM_HEALTH_CHECK_TIMEOUT_MS) });
          logger?.info(`Gondolin VM health check passed for arc ${arc}`);
        } catch (err) {
          logger?.warn(`Gondolin checkpoint resume/health-check failed for arc ${arc}, deleting checkpoint and starting fresh VM`, String(err));
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
    } catch (err) {
      const rewrittenError = rewriteMissingQemuBinaryError(err);
      if (rewrittenError) throw rewrittenError;
      throw err;
    } finally {
      if (slotAcquired) {
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

// ── VM operations factories ────────────────────────────────────────────────

export function createVmReadOps(getVm: () => Promise<VM>, opTimeoutMs: number, logger?: Logger): ReadOperations {
  return {
    readFile: async (absolutePath) => {
      const vm = await getVm();
      return vm.fs.readFile(absolutePath, { signal: AbortSignal.timeout(opTimeoutMs) });
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

export function createVmWriteOps(getVm: () => Promise<VM>, opTimeoutMs: number): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      const vm = await getVm();
      const dir = posix.dirname(absolutePath);
      await vm.exec(["/bin/mkdir", "-p", dir], { signal: AbortSignal.timeout(opTimeoutMs) });
      await vm.fs.writeFile(absolutePath, content, { encoding: "utf8", signal: AbortSignal.timeout(opTimeoutMs) });
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

export function createVmEditOps(getVm: () => Promise<VM>, opTimeoutMs: number, logger?: Logger): EditOperations {
  const readOps = createVmReadOps(getVm, opTimeoutMs, logger);
  const writeOps = createVmWriteOps(getVm, opTimeoutMs);
  return {
    readFile: readOps.readFile,
    access: readOps.access,
    writeFile: writeOps.writeFile,
  };
}

export function createVmBashOps(
  getVm: () => Promise<VM>,
  defaultTimeoutSeconds: number,
  sessionEnv?: Record<string, string>,
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const vm = await getVm();

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

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
        // HOME, PATH, VIRTUAL_ENV are set by the gondolin image profile.
        const wrappedCommand = command;
        const proc = vm.exec(["/bin/bash", "-lc", wrappedCommand], {
          cwd,
          signal: ac.signal,
          stdout: "pipe",
          stderr: "pipe",
          ...(sessionEnv ? { env: sessionEnv } : {}),
        });

        let totalBytes = 0;
        let capped = false;
        for await (const chunk of proc.output()) {
          if (capped) {
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

// ── Close / checkpoint / cleanup ───────────────────────────────────────────

/** Close all cached VMs. Exported for testing and used by process exit handlers. */
export async function closeAllVms(): Promise<void> {
  const vmCount = vmCache.size;
  const vms = [...vmCache.values()];
  vmCache.clear();
  await Promise.allSettled(vms.map((vm) => vm.close().catch(() => {})));
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
    process.removeListener("SIGTERM", sigtermHandler);
    process.removeListener("SIGINT", sigintHandler);
    process.kill(process.pid, signal as NodeJS.Signals);
  };

  const sigintHandler = () => void asyncCleanup("SIGINT");
  const sigtermHandler = () => void asyncCleanup("SIGTERM");

  process.on("SIGTERM", sigtermHandler);
  process.on("SIGINT", sigintHandler);

  process.on("exit", () => {
    for (const vm of vmCache.values()) {
      try {
        vm.close().catch(() => {});
      } catch {
        // ignore
      }
    }
    vmCache.clear();
  });
}

installProcessCleanupHandlers();

/** Register a session as active (prevents checkpoint while running). */
export function registerActiveSession(arc: string): void {
  vmActiveSessions.set(arc, (vmActiveSessions.get(arc) ?? 0) + 1);
}

/**
 * Checkpoint the Gondolin VM for an arc after a session ends.
 *
 * Prunes old session directories inside /tmp (keeping the 8 most recent), then
 * stops the VM and persists its disk state to `$MUADDIB_HOME/arcs/<arcId>/checkpoint.qcow2`.
 * The VM is removed from the cache so the next invocation resumes from the checkpoint.
 *
 * This is a no-op if no VM is running for the arc.
 */
export async function checkpointGondolinArc(
  arc: string,
  logger?: Logger,
): Promise<void> {
  const current = vmActiveSessions.get(arc) ?? 0;
  if (current <= 0) {
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

  const inFlight = vmCheckpointInProgress.get(arc);
  if (inFlight) {
    logger?.debug(`Gondolin arc ${arc}: checkpoint already in progress, waiting`);
    return inFlight;
  }

  const checkpointPath = getArcCheckpointPath(arc);

  vmCache.delete(arc);

  const checkpointPromise = (async () => {
    try {
      await vm.exec(["/bin/sh", "-c",
        "ls -1dt /workspace/.sessions/session-* 2>/dev/null | tail -n +9 | xargs rm -rf"]);
      await checkpointVmWithOverwriteWorkaround(arc, vm, checkpointPath, logger);
      logger?.info(`Gondolin VM checkpointed for arc ${arc}: ${checkpointPath}`);
    } catch (err) {
      const reportedError = rewriteMissingQemuBinaryError(err) ?? err;
      logger?.error(`Gondolin checkpoint failed for arc ${arc}`, String(reportedError));
      await vm.close().catch(() => {});
    } finally {
      vmCheckpointInProgress.delete(arc);
      releaseVmSlot();
    }
  })();

  vmCheckpointInProgress.set(arc, checkpointPromise);
  return checkpointPromise;
}

// ── Exported for testing ───────────────────────────────────────────────────

/** Returns current semaphore state — for tests only. */
export function getVmSlotState(): { active: number; limit: number | undefined; waiters: number } {
  return { active: vmSlotActive, limit: vmSlotLimit, waiters: vmSlotWaiters.length };
}

export function resetGondolinVmCache(): void {
  vmCache.clear();
  vmCacheLocks.clear();
  vmActiveSessions.clear();
  vmCheckpointInProgress.clear();
  vmSlotActive = 0;
  vmSlotLimit = undefined;
  vmSlotWaiters.splice(0);
}

// ── Session VM accessor ─────────────────────────────────────────────────────

export interface VmSessionOptions {
  arc: string;
  serverTag?: string;
  channelName?: string;
  config: GondolinConfig;
  authStorage?: AuthStorage;
  artifactsPath?: string;
  artifactsUrl?: string;
  vmOpTimeoutMs: number;
  logger?: Logger;
  eventsWatcher?: ArcEventsWatcher;
}

export interface VmSession {
  getVm: () => Promise<VM>;
  sessionDir: string;
}

/**
 * Create a lazy VM accessor for a single session.
 *
 * Ensures the host workspace directory exists, registers the session as active
 * (so checkpoint is deferred), and returns a `getVm()` function that ensures
 * the VM exists (creating it on first call) and creates the session working
 * directory inside the guest.
 */
export function createVmSession(opts: VmSessionOptions): VmSession {
  const { arc, vmOpTimeoutMs, logger } = opts;

  // Validate dnsMode eagerly so invalid config is caught at session creation,
  // not deferred to the first VM operation.
  resolveDnsMode(opts.config.dnsMode);

  // Ensure the workspace directory exists and stamp the arc name into it so
  // external tools (e.g. scripts/gondolin-shell.sh) can identify which arc
  // owns a given workspace ID.
  const workspacePath = getArcWorkspacePath(arc);
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(workspacePath, ".arc-name"), arc, "utf8");

  // Register this session immediately so checkpointGondolinArc knows it is
  // active even before the VM has been started or any tool has been called.
  registerActiveSession(arc);

  const sessionDir = `/workspace/.sessions/session-${randomUUID().slice(0, 8)}`;

  let vmReady: Promise<VM> | null = null;

  function getVm(): Promise<VM> {
    if (!vmReady) {
      vmReady = ensureVm(opts).then(
        async (vm) => {
          await vm.exec(["/bin/mkdir", "-p", sessionDir], { signal: AbortSignal.timeout(vmOpTimeoutMs) });
          logger?.info(`Gondolin session dir: ${sessionDir} (arc: ${arc})`);
          return vm;
        },
      );
    }
    return vmReady;
  }

  return { getVm, sessionDir };
}
