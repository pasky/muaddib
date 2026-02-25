import {
  appendFileSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, Message, UserMessage } from "@mariozechner/pi-ai";

import type { RoomMessage } from "../rooms/message.js";

export type ChatRole = "user" | "assistant";

/**
 * Construct stub fields for AssistantMessage objects created from persisted context.
 * Returns fresh nested objects on each call to avoid accidental shared mutations.
 */
export function createStubAssistantFields(): Pick<AssistantMessage, "api" | "provider" | "model" | "usage" | "stopReason"> {
  return {
    api: "",
    provider: "",
    model: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
  };
}

/** A single JSONL line — bag of optional fields, no type discriminator. */
export interface JsonlLine {
  ts: string;
  n?: string;
  r?: ChatRole;
  m?: string;
  run?: string;
  call?: string;
  model?: string;
  inTok?: number;
  outTok?: number;
  cost?: number;
  mode?: string;
  pid?: string;
  tid?: string;
  edit?: boolean;
}

export interface HistoryMessageRow {
  nick: string;
  message: string;
  role: ChatRole;
  timestamp: string;
}

export class ChatHistoryStore {
  private readonly arcsBasePath: string;
  private readonly inferenceLimit: number;
  /** Tracks chat_history dirs already confirmed to exist — avoids mkdirSync per message. */
  private readonly createdHistoryDirs = new Set<string>();

  constructor(arcsBasePath: string, inferenceLimit = 5) {
    this.arcsBasePath = arcsBasePath;
    this.inferenceLimit = inferenceLimit;
  }

  async initialize(): Promise<void> {
    mkdirSync(this.arcsBasePath, { recursive: true });
  }

  async close(): Promise<void> {
    // no-op — no DB handle
  }

  /**
   * Store a chat message. Returns the ISO timestamp used as the line's ts.
   */
  async addMessage(
    message: RoomMessage,
    options: {
      mode?: string | null;
      contentTemplate?: string;
      role?: ChatRole;
      /** When true, set `run` to the line's own `ts` (for trigger messages). */
      selfRun?: boolean;
      run?: string;
      call?: string;
      model?: string;
      inTok?: number;
      outTok?: number;
      cost?: number;
    } = {},
  ): Promise<string> {
    const arc = message.arc;
    const role = options.role ?? this.defaultRoleForMessage(message);
    // Store raw message text — formatting happens on read.
    const isBotMessage = message.nick.toLowerCase() === message.mynick.toLowerCase();
    let rawText = isBotMessage ? message.content : (message.originalContent ?? message.content);
    if (options.contentTemplate) {
      rawText = options.contentTemplate.replace("{message}", rawText);
    }

    const ts = new Date().toISOString();
    const line: JsonlLine = {
      ts,
      n: message.nick,
      r: role,
      m: rawText,
    };

    if (options.mode) line.mode = options.mode;
    if (options.selfRun) line.run = ts;
    if (options.run) line.run = options.run;
    if (options.call) line.call = options.call;
    if (options.model) line.model = options.model;
    if (options.inTok !== undefined) line.inTok = options.inTok;
    if (options.outTok !== undefined) line.outTok = options.outTok;
    if (options.cost !== undefined) line.cost = options.cost;
    if (message.platformId) line.pid = message.platformId;
    if (message.responseThreadId ?? message.threadId) {
      line.tid = message.responseThreadId ?? message.threadId;
    }

    this.appendLine(arc, line);
    return ts;
  }

  /**
   * Log a non-chat LLM cost (chronicler, oracle, classifier, etc.).
   */
  async logLlmCost(
    arc: string,
    opts: {
      run?: string;
      call: string;
      model: string;
      inTok?: number;
      outTok?: number;
      cost?: number;
    },
  ): Promise<void> {
    const line: JsonlLine = {
      ts: new Date().toISOString(),
    };
    if (opts.run) line.run = opts.run;
    line.call = opts.call;
    line.model = opts.model;
    if (opts.inTok !== undefined) line.inTok = opts.inTok;
    if (opts.outTok !== undefined) line.outTok = opts.outTok;
    if (opts.cost !== undefined) line.cost = opts.cost;

    this.appendLine(arc, line);
  }

  async getContextForMessage(
    message: RoomMessage,
    limit?: number,
  ): Promise<Message[]> {
    return this.getContext(message.arc, limit, message.threadId);
  }

  async getContext(
    arc: string,
    limit?: number,
    threadId?: string,
  ): Promise<Message[]> {
    const inferenceLimit = limit ?? this.inferenceLimit;
    const lines = threadId
      ? await this.readThreadContext(arc, threadId, inferenceLimit)
      : await this.readMainContext(arc, inferenceLimit);
    return this.formatContextLines(lines);
  }

  async getFullHistory(
    arc: string,
    limit?: number,
  ): Promise<HistoryMessageRow[]> {
    const allLines: JsonlLine[] = [];
    for await (const line of this.streamNewestFirst(arc)) {
      if (line.m !== undefined) {
        allLines.push(line);
      }
    }
    // allLines is newest-first; reverse to get chronological order
    allLines.reverse();
    const selected = limit !== undefined ? allLines.slice(-limit) : allLines;

    return selected.map((line) => ({
      nick: line.n ?? "?",
      message: `<${line.n ?? "?"}> ${line.m ?? ""}`,
      role: (line.r ?? "user") as ChatRole,
      timestamp: line.ts,
    }));
  }

  /**
   * Replaces getFullHistory for the chronicler — anchors by cursor timestamp.
   * Returns up to maxBatch unchronicled messages after the cursor, plus up to
   * overlap already-chronicled messages before it (for conversational context),
   * all in chronological order.
   */
  async readChroniclerContext(arc: string, maxBatch: number, overlap = 0): Promise<Array<{ message: string; timestamp: string }>> {
    const cursor = await this.readCursorTs(arc);

    const unchronicled: JsonlLine[] = [];
    const pre: JsonlLine[] = [];
    let pastCursor = false;
    for await (const line of this.streamNewestFirst(arc)) {
      if (line.m === undefined) continue;
      if (!pastCursor && cursor && line.ts <= cursor) {
        pastCursor = true;
      }
      if (!pastCursor) {
        // Unchronicled: after cursor
        unchronicled.push(line);
        if (unchronicled.length >= maxBatch) break;
      } else {
        // Already chronicled: collect overlap context before cursor
        pre.push(line);
        if (pre.length >= overlap) break;
      }
    }

    // Both arrays are newest-first; reverse each, then pre-cursor context comes first.
    pre.reverse();
    unchronicled.reverse();
    return [...pre, ...unchronicled].map((line) => ({
      message: `<${line.n ?? "?"}> ${line.m ?? ""}`,
      timestamp: line.ts,
    }));
  }

  /**
   * Count messages in an arc since the given epoch timestamp (ms).
   */
  async countMessagesSince(arc: string, sinceEpochMs: number): Promise<number> {
    const sinceTs = new Date(sinceEpochMs).toISOString();
    let count = 0;
    for await (const line of this.streamNewestFirst(arc)) {
      if (line.ts < sinceTs) break;
      if (line.m !== undefined) count++;
    }
    return count;
  }

  async countRecentUnchronicled(arc: string, days = 7): Promise<number> {
    const cursor = await this.readCursorTs(arc);
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const effectiveCutoff = cursor && cursor > cutoff ? cursor : cutoff;

    let count = 0;
    for await (const line of this.streamNewestFirst(arc)) {
      if (line.ts <= effectiveCutoff) break;
      if (line.m !== undefined) count++;
    }
    return count;
  }

  markChronicled(arc: string, cursorTs: string): void {
    const path = this.cursorPath(arc);
    mkdirSync(join(this.arcsBasePath, arc, "chronicle"), { recursive: true });
    const tmpPath = path + ".tmp";
    writeFileSync(tmpPath, JSON.stringify({ ts: cursorTs }) + "\n", "utf-8");
    renameSync(tmpPath, path);
  }

  async getArcCostToday(arcName: string): Promise<number> {
    const todayFile = this.jsonlPath(arcName, this.todayDate());
    const lines = await this.readJsonlFile(todayFile);
    let total = 0;
    for (const line of lines) {
      if (line.cost !== undefined) {
        total += line.cost;
      }
    }
    return total;
  }

  /**
   * Append an edit line. On context read, the latest line per pid wins.
   */
  async appendEdit(arc: string, pid: string, content: string, nick: string, role?: ChatRole): Promise<void> {
    const line: JsonlLine = {
      ts: new Date().toISOString(),
      n: nick,
      r: role ?? "user",
      m: content,
      pid,
      edit: true,
    };
    this.appendLine(arc, line);
  }

  // ── Internal I/O ──

  private appendLine(arc: string, line: JsonlLine): void {
    const date = line.ts.slice(0, 10);
    const filePath = this.jsonlPath(arc, date);
    const dirKey = join(this.arcsBasePath, arc, "chat_history");
    if (!this.createdHistoryDirs.has(dirKey)) {
      mkdirSync(dirKey, { recursive: true });
      this.createdHistoryDirs.add(dirKey);
    }
    appendFileSync(filePath, JSON.stringify(line) + "\n", "utf-8");
  }

  private async readJsonlFile(path: string): Promise<JsonlLine[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      return [];
    }
    const lines: JsonlLine[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        lines.push(JSON.parse(trimmed));
      } catch {
        // skip malformed lines
      }
    }
    return lines;
  }

  /**
   * Yields lines from newest to oldest across all JSONL files for an arc.
   * No filtering or stopping logic — callers apply their own conditions.
   */
  private async *streamNewestFirst(arc: string): AsyncGenerator<JsonlLine> {
    const dir = join(this.arcsBasePath, arc, "chat_history");

    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      return;
    }

    // Read files newest-first
    for (let i = files.length - 1; i >= 0; i--) {
      const fileLines = await this.readJsonlFile(join(dir, files[i]));
      // Yield lines within each file newest-first (reverse order)
      for (let j = fileLines.length - 1; j >= 0; j--) {
        yield fileLines[j];
      }
    }
  }

  /**
   * Read main-channel context lines (oldest-first), deduped by (pid, role).
   * Skips lines with tid (thread lines) and non-message lines.
   */
  private async readMainContext(arc: string, limit: number): Promise<JsonlLine[]> {
    const seen = new Set<string>();
    const collected: JsonlLine[] = [];

    for await (const line of this.streamNewestFirst(arc)) {
      // Only message lines, not threaded
      if (line.m === undefined || line.tid) continue;

      // Dedup by (pid, role): first occurrence newest-first = latest version
      if (line.pid) {
        const key = `${line.pid}\0${line.r ?? "user"}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }

      collected.push(line);
      if (collected.length >= limit) break;
    }

    return collected.reverse();
  }

  /**
   * Read thread context lines (oldest-first), deduped by (pid, role).
   *
   * Phase 1 (before starter found): collect thread replies (tid === threadId)
   *   and watch for the starter: line.pid === threadId && (!line.tid || line.tid === line.pid)
   * Phase 2 (after starter found): collect pre-starter main-channel lines (!tid, m only)
   *   until total collected >= limit.
   *
   * The starter line itself is counted in the total.
   */
  private async readThreadContext(arc: string, threadId: string, limit: number): Promise<JsonlLine[]> {
    const seen = new Set<string>();
    const collected: JsonlLine[] = [];
    let foundStarter = false;

    const deduped = (line: JsonlLine): boolean => {
      if (!line.pid) return false; // no dedup needed
      const key = `${line.pid}\0${line.r ?? "user"}`;
      if (seen.has(key)) return true; // duplicate
      seen.add(key);
      return false;
    };

    for await (const line of this.streamNewestFirst(arc)) {
      if (collected.length >= limit) break;

      if (!foundStarter) {
        // Phase 1: looking for starter and collecting thread replies

        // Check for starter FIRST (Slack auto-thread: tid===pid===threadId)
        if (line.pid === threadId && (!line.tid || line.tid === line.pid)) {
          if (!deduped(line)) {
            collected.push(line);
          }
          foundStarter = true;
          continue;
        }

        // Collect thread replies (tid === threadId), skip everything else
        if (line.tid === threadId) {
          if (!deduped(line)) {
            collected.push(line);
          }
        }
      } else {
        // Phase 2: collect pre-starter context lines
        if (line.m !== undefined) {
          if (line.tid === threadId) {
            // Older thread member below the starter (e.g. root user message in Slack auto-thread
            // where both user root and bot root share pid===tid===threadId).
            if (!deduped(line)) collected.push(line);
          } else if (!line.tid) {
            // Pre-starter main-channel message
            if (!deduped(line)) collected.push(line);
          }
        }
      }
    }

    return collected.reverse();
  }

  /**
   * Format collected JsonlLine[] into Message[] for inference.
   */
  private formatContextLines(lines: JsonlLine[]): Message[] {
    return lines.map((line): Message => {
      const timeOnly = line.ts.slice(11, 16); // HH:MM
      const nick = line.n ?? "?";
      const content = line.m ?? "";
      const formatted = `<${nick}> ${content}`;
      const modePrefix = line.r === "assistant" && line.mode ? this.modeToPrefix(line.mode) : "";
      const text = `${modePrefix}[${timeOnly}] ${formatted}`;
      const timestamp = new Date(line.ts).getTime() || 0;

      if (line.r === "assistant") {
        return {
          role: "assistant",
          content: [{ type: "text", text }],
          ...createStubAssistantFields(),
          timestamp,
        } satisfies AssistantMessage;
      }
      return {
        role: "user",
        content: text,
        timestamp,
      } satisfies UserMessage;
    });
  }

  private jsonlPath(arc: string, date: string): string {
    return join(this.arcsBasePath, arc, "chat_history", `${date}.jsonl`);
  }

  private todayDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  // ── Chronicle cursor ──

  private cursorPath(arc: string): string {
    return join(this.arcsBasePath, arc, "chronicle", "cursor.json");
  }

  private async readCursorTs(arc: string): Promise<string | null> {
    const path = this.cursorPath(arc);
    try {
      const data = JSON.parse(await readFile(path, "utf-8"));
      return data.ts ?? null;
    } catch {
      return null;
    }
  }

  // ── Helpers ──

  private defaultRoleForMessage(message: RoomMessage): ChatRole {
    return message.nick.toLowerCase() === message.mynick.toLowerCase() ? "assistant" : "user";
  }

  private modeToPrefix(mode: string): string {
    if (!mode) return "";
    if (mode.startsWith("!")) return `${mode} `;
    return "";
  }
}
