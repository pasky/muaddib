/**
 * ArcEventsWatcher — manages scheduled events across all arcs.
 *
 * Events are JSON files in `$MUADDIB_HOME/arcs/<arc>/events/`.  Two types:
 *   - one-shot: fires once at a specific ISO 8601 time, then auto-deletes.
 *   - periodic: fires on a cron schedule, persists until manually deleted.
 *
 * The watcher is notified of file changes by NotifyingProvider callbacks
 * (synchronous with the VFS operation — no fs.watch needed).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

import { Cron } from "croner";

import type { Logger } from "../app/logging.js";
import { getMuaddibHome } from "../config/paths.js";
import { getArcEventsDir } from "../agent/gondolin/fs.js";
import type { RoomGateway } from "../rooms/room-gateway.js";

// ── Event schema ────────────────────────────────────────────────────────

interface OneShotEvent {
  type: "one-shot";
  text: string;
  at: string; // ISO 8601
  threadId?: string;
}

interface PeriodicEvent {
  type: "periodic";
  text: string;
  schedule: string; // cron expression
  timezone?: string;
  threadId?: string;
}

type ParsedEvent = OneShotEvent | PeriodicEvent;

// ── Watcher options ──────────────────────────────────────────────────────

export interface ArcEventsWatcherOptions {
  /** Minimum period between periodic event fires in ms. */
  minPeriodMs: number;
  /** Heartbeat check interval in ms. 0 disables. */
  heartbeatIntervalMs: number;
}

/**
 * Detach a callback from the current AsyncLocalStorage context.
 *
 * `onFileWritten` fires inside the calling agent's `withMessageContext()`,
 * which means `setTimeout` / `Cron` callbacks inherit that context and
 * route their logs to the (now-closed) per-message log instead of system.log.
 * Wrapping with `AsyncLocalStorage.snapshot()` at module-load time captures
 * an empty context, ensuring timer callbacks always log to system.log.
 */
const detach = AsyncLocalStorage.snapshot();

// ── Synthetic message format ────────────────────────────────────────────

function buildEventMessage(path: string, event: ParsedEvent): string {
  const separator = "----------";
  if (event.type === "periodic") {
    const meta =
      `<meta>The above was current conversation context, which may or may not be relevant at all to the task at hand - ` +
      `you have just been launched asynchronously to handle a pre-scheduled instruction. Anything you write will be ` +
      `seen outside as 'out of the blue' so keep your chatter to only relevant notices it's important to share - ` +
      `likely, you will not say anything at all, unlikely it was explicitly asked for below. ` +
      `Finish with string NULL once done if no notification needs to be sent.</meta>`;
    return `${separator}\n${meta}\n[EVENT:${path}:periodic:${event.schedule}] ${event.text}`;
  }
  // one-shot
  const meta =
    `<meta>The above was current conversation context, which may or may not be relevant at all to the task at hand - ` +
    `you have just been launched asynchronously to handle a pre-scheduled instruction. Anything you write will be ` +
    `seen outside as 'out of the blue', speak accordingly.</meta>`;
  return `${separator}\n${meta}\n[EVENT:${path}:one-shot:${event.at}] ${event.text}`;
}

// ── Job tracking ────────────────────────────────────────────────────────

interface ScheduledJob {
  type: "one-shot" | "periodic";
  /** setTimeout id for one-shot, or Cron instance for periodic. */
  handle: ReturnType<typeof setTimeout> | Cron;
  /** Thread to reply into when firing (Slack thread_ts, etc.). */
  threadId?: string;
}

function cancelJob(job: ScheduledJob): void {
  if (job.type === "one-shot") {
    clearTimeout(job.handle as ReturnType<typeof setTimeout>);
  } else {
    (job.handle as Cron).stop();
  }
}

// ── ArcEventsWatcher ────────────────────────────────────────────────────

export { getArcEventsDir };

export class ArcEventsWatcher {
  /** Map from `${arc}/${filename}` to its scheduled job. */
  private readonly jobs = new Map<string, ScheduledJob>();
  /** Track last fire time per job key for rate limiting. */
  private readonly lastFireTime = new Map<string, number>();
  private readonly minPeriodMs: number;
  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly gateway: RoomGateway,
    private readonly logger: Logger | undefined,
    private readonly options: ArcEventsWatcherOptions,
  ) {
    this.minPeriodMs = options.minPeriodMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
  }

  // ── NotifyingProvider callbacks ──────────────────────────────────────

  onFileWritten(arc: string, filename: string): void {
    if (!filename.endsWith(".json")) return;
    const key = `${arc}/${filename}`;
    // Cancel any existing job for this file (re-schedule).
    const existing = this.jobs.get(key);
    if (existing) {
      cancelJob(existing);
      this.jobs.delete(key);
    }

    const eventsDir = getArcEventsDir(arc);
    const filePath = join(eventsDir, filename);
    let event: ParsedEvent;
    try {
      const raw = readFileSync(filePath, "utf8");
      event = parseEventFile(raw, filename);
    } catch (err) {
      this.logger?.warn(`Events: failed to parse ${filePath}`, String(err));
      // Re-throw so the error propagates back through NotifyingProvider
      // to the write tool, letting the agent see the validation failure.
      throw err;
    }

    this.scheduleEvent(arc, filename, event);
  }

  onFileDeleted(arc: string, filename: string): void {
    if (!filename.endsWith(".json")) return;
    const key = `${arc}/${filename}`;
    const existing = this.jobs.get(key);
    if (existing) {
      cancelJob(existing);
      this.jobs.delete(key);
      this.logger?.debug(`Events: cancelled job for deleted file ${key}`);
    }
  }

  // ── Startup scan ────────────────────────────────────────────────────

  scanArc(arc: string): void {
    const eventsDir = getArcEventsDir(arc);
    if (!existsSync(eventsDir)) return;

    let files: string[];
    try {
      files = readdirSync(eventsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }

    for (const filename of files) {
      const filePath = join(eventsDir, filename);
      try {
        const raw = readFileSync(filePath, "utf8");
        const event = parseEventFile(raw, filename);

        if (event.type === "one-shot") {
          const at = new Date(event.at).getTime();
          if (at <= Date.now()) {
            // Stale one-shot — discard without firing.
            this.logger?.info(`Events: discarding stale one-shot ${arc}/${filename}`);
            try { unlinkSync(filePath); } catch { /* ignore */ }
            continue;
          }
        }

        this.scheduleEvent(arc, filename, event);
      } catch (err) {
        this.logger?.warn(`Events: failed to load ${filePath} during scan`, String(err));
      }
    }
  }

  /** Scan all arcs that have an events directory. */
  start(): void {
    const arcsDir = join(getMuaddibHome(), "arcs");
    if (!existsSync(arcsDir)) return;

    let arcDirs: string[];
    try {
      arcDirs = readdirSync(arcsDir);
    } catch {
      return;
    }

    for (const arc of arcDirs) {
      this.scanArc(arc);
    }

    this.logger?.info(`Events: started, ${this.jobs.size} job(s) scheduled`);
    this.startHeartbeat();
  }

  stop(): void {
    this.stopHeartbeat();
    for (const job of this.jobs.values()) {
      cancelJob(job);
    }
    this.jobs.clear();
    this.lastFireTime.clear();
    this.logger?.info("Events: stopped");
  }

  // ── Heartbeat ──────────────────────────────────────────────────────

  private startHeartbeat(): void {
    if (this.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(
      () => detach(() => this.scanHeartbeats()),
      this.heartbeatIntervalMs,
    );
    this.heartbeatTimer.unref();
    this.logger?.info(`Events: heartbeat enabled, interval ${this.heartbeatIntervalMs}ms`);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scanHeartbeats(): void {
    const arcsDir = join(getMuaddibHome(), "arcs");
    if (!existsSync(arcsDir)) return;

    let arcDirs: string[];
    try {
      arcDirs = readdirSync(arcsDir);
    } catch {
      return;
    }

    for (const arc of arcDirs) {
      const heartbeatPath = join(arcsDir, arc, "workspace", "HEARTBEAT.md");
      let content: string;
      try {
        if (!existsSync(heartbeatPath)) continue;
        content = readFileSync(heartbeatPath, "utf8");
      } catch {
        continue;
      }

      if (isHeartbeatContentEmpty(content)) continue;

      // Rate-limit per arc using the same lastFireTime map.
      const key = `${arc}/HEARTBEAT.md`;
      const now = Date.now();
      const last = this.lastFireTime.get(key);
      if (last !== undefined && now - last < this.minPeriodMs) {
        this.logger?.debug(`Events: rate-limited heartbeat for ${arc}`);
        continue;
      }
      this.lastFireTime.set(key, now);

      const event: PeriodicEvent = {
        type: "periodic",
        text: `/workspace/HEARTBEAT.md:\n${content.trim()}`,
        schedule: `${Math.round(this.heartbeatIntervalMs / 60000)}m`,
      };
      const message = buildEventMessage("/workspace/HEARTBEAT.md", event);
      this.logger?.info(`Events: firing heartbeat for ${arc}`);
      this.gateway.inject(arc, message).catch((err) => {
        this.logger?.error(`Events: failed to inject heartbeat for ${arc}`, String(err));
      });
    }
  }

  // ── Internal scheduling ─────────────────────────────────────────────

  private scheduleEvent(arc: string, filename: string, event: ParsedEvent): void {
    const key = `${arc}/${filename}`;

    if (event.type === "one-shot") {
      const at = new Date(event.at).getTime();
      const delayMs = at - Date.now();
      if (delayMs <= 0) {
        // Already past — discard.
        this.logger?.info(`Events: discarding past one-shot ${key}`);
        this.deleteEventFile(arc, filename);
        return;
      }

      const threadId = event.threadId;
      const timer = setTimeout(() => detach(() => {
        this.jobs.delete(key);
        this.fire(arc, filename, event);
        this.deleteEventFile(arc, filename);
      }), delayMs);

      // Don't keep the process alive just for event timers.
      if (timer.unref) timer.unref();
      this.jobs.set(key, { type: "one-shot", handle: timer, threadId });
      this.logger?.info(`Events: scheduled one-shot ${key} at ${event.at} (${Math.round(delayMs / 1000)}s)`);
    } else {
      // periodic
      const cron = new Cron(event.schedule, {
        timezone: event.timezone,
      }, () => detach(() => {
        // Rate-limit: enforce minimum 30-minute gap between fires.
        const now = Date.now();
        const last = this.lastFireTime.get(key);
        if (last !== undefined && now - last < this.minPeriodMs) {
          this.logger?.debug(`Events: rate-limited periodic ${key}`);
          return;
        }
        this.lastFireTime.set(key, now);
        this.fire(arc, filename, event);
      }));

      this.jobs.set(key, { type: "periodic", handle: cron, threadId: event.threadId });
      this.logger?.info(`Events: scheduled periodic ${key} [${event.schedule}]`);
    }
  }

  private fire(arc: string, filename: string, event: ParsedEvent): void {
    const content = buildEventMessage(`/events/${filename}`, event);
    this.logger?.info(`Events: firing ${event.type} ${arc}/${filename}`);
    this.gateway.inject(arc, content, { threadId: event.threadId }).catch((err) => {
      this.logger?.error(`Events: failed to inject event ${arc}/${filename}`, String(err));
    });
  }

  private deleteEventFile(arc: string, filename: string): void {
    const filePath = join(getArcEventsDir(arc), filename);
    try {
      unlinkSync(filePath);
      this.logger?.debug(`Events: auto-deleted ${filePath}`);
    } catch {
      // File may already be gone.
    }
  }
}

// ── Parsing ─────────────────────────────────────────────────────────────

function parseEventFile(raw: string, filename: string): ParsedEvent {
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== "object") {
    throw new Error(`${filename}: not a JSON object`);
  }

  const { type } = obj;
  if (type === "one-shot") {
    const { text, at, threadId } = obj;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(`${filename}: one-shot event missing "text"`);
    }
    if (typeof at !== "string" || !at.trim()) {
      throw new Error(`${filename}: one-shot event missing "at"`);
    }
    // Validate date
    if (Number.isNaN(new Date(at).getTime())) {
      throw new Error(`${filename}: invalid "at" date: ${at}`);
    }
    const result: OneShotEvent = { type: "one-shot", text: text.trim(), at };
    if (typeof threadId === "string" && threadId.trim()) {
      result.threadId = threadId.trim();
    }
    return result;
  }

  if (type === "periodic") {
    const { text, schedule, timezone } = obj;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(`${filename}: periodic event missing "text"`);
    }
    if (typeof schedule !== "string" || !schedule.trim()) {
      throw new Error(`${filename}: periodic event missing "schedule"`);
    }
    // Validate cron expression by attempting to create a Cron.
    try {
      const testCron = new Cron(schedule, { timezone });
      testCron.stop();
    } catch (err) {
      throw new Error(`${filename}: invalid cron schedule "${schedule}": ${err}`, { cause: err });
    }

    const result: PeriodicEvent = { type: "periodic", text: text.trim(), schedule };
    if (typeof timezone === "string" && timezone.trim()) {
      result.timezone = timezone.trim();
    }
    if (typeof obj.threadId === "string" && obj.threadId.trim()) {
      result.threadId = obj.threadId.trim();
    }
    return result;
  }

  throw new Error(`${filename}: unknown event type "${type}" (expected "one-shot" or "periodic")`);
}

// ── Heartbeat content check ──────────────────────────────────────────────

/**
 * Returns true if the heartbeat content is effectively empty:
 * only whitespace, markdown headers, HTML comments, or empty checklist items.
 */
function isHeartbeatContentEmpty(content: string): boolean {
  const stripped = content
    .replace(/<!--[\s\S]*?-->/g, "")  // remove HTML comments
    .replace(/^#+\s*.*$/gm, "")       // remove markdown headers
    .replace(/^-\s*\[\s*\]\s*$/gm, "") // remove empty checklist items
    .trim();
  return stripped.length === 0;
}

// Exported for testing
export { parseEventFile as _parseEventFile, buildEventMessage as _buildEventMessage, isHeartbeatContentEmpty as _isHeartbeatContentEmpty };
export type { ParsedEvent, OneShotEvent, PeriodicEvent };
