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
import { fsSafeArc } from "../rooms/message.js";

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
      run?: string;
      call?: string;
      model?: string;
      inTok?: number;
      outTok?: number;
      cost?: number;
    } = {},
  ): Promise<string> {
    const arc = fsSafeArc(`${message.serverTag}#${message.channelName}`);
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
    const arc = fsSafeArc(`${message.serverTag}#${message.channelName}`);
    return this.getContext(arc, limit, message.threadId);
  }

  async getContext(
    arc: string,
    limit?: number,
    threadId?: string,
  ): Promise<Message[]> {
    const inferenceLimit = limit ?? this.inferenceLimit;

    let lines: JsonlLine[];
    if (threadId) {
      // Thread context: need to scan back to find thread starter + main channel
      // context before it. Read all recent lines (no early-stop).
      lines = await this.readRecentLines(arc);
    } else {
      // Non-thread: read in reverse and stop early once we have enough lines.
      // Use a multiplier to absorb thread messages, cost lines, and edits that
      // will be filtered out before the final slice(-inferenceLimit).
      lines = await this.readRecentLines(arc, 30, inferenceLimit * 4);
    }

    // Filter: only lines with m (messages, not bare cost lines)
    const messageLines = lines.filter((l) => l.m !== undefined);

    let selected: JsonlLine[];
    if (threadId) {
      selected = this.selectThreadContext(messageLines, threadId, inferenceLimit);
    } else {
      // Main channel: lines without tid
      const mainLines = messageLines.filter((l) => !l.tid);
      selected = this.dedupeEdits(mainLines).slice(-inferenceLimit);
    }

    return selected.map((line): Message => {
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

  async getFullHistory(
    arc: string,
    limit?: number,
  ): Promise<HistoryMessageRow[]> {
    const lines = await this.readRecentLines(arc, 30, limit !== undefined ? limit * 2 : undefined);
    const messageLines = lines.filter((l) => l.m !== undefined);
    const selected = limit !== undefined ? messageLines.slice(-limit) : messageLines;

    return selected.map((line) => ({
      nick: line.n ?? "?",
      message: `<${line.n ?? "?"}> ${line.m ?? ""}`,
      role: (line.r ?? "user") as ChatRole,
      timestamp: line.ts,
    }));
  }

  /**
   * Count messages in an arc since the given epoch timestamp (ms).
   * Reads all files from the date of sinceEpochMs onwards, so it correctly
   * handles midnight boundaries (e.g. proactive debounce starting at 23:59).
   */
  async countMessagesSince(arc: string, sinceEpochMs: number): Promise<number> {
    const sinceTs = new Date(sinceEpochMs).toISOString();
    const sinceDate = sinceTs.slice(0, 10);
    const dir = join(this.arcsBasePath, arc, "chat_history");

    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      return 0;
    }

    // Only read files at or after sinceDate
    const relevantFiles = files.filter((f) => f.replace(".jsonl", "") >= sinceDate);

    let count = 0;
    for (const file of relevantFiles) {
      const lines = await this.readJsonlFile(join(dir, file));
      count += lines.filter((l) => l.m !== undefined && l.ts >= sinceTs).length;
    }
    return count;
  }

  async countRecentUnchronicled(arc: string, days = 7): Promise<number> {
    const cursor = await this.readCursorTs(arc);
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const effectiveCutoff = cursor && cursor > cutoff ? cursor : cutoff;

    const lines = await this.readRecentLines(arc, days);
    return lines.filter(
      (l) => l.m !== undefined && l.ts > effectiveCutoff,
    ).length;
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
   * Read JSONL lines in chronological order.
   *
   * When `maxLines` is given, files are read newest-first and we stop once
   * `maxLines` have been accumulated — avoiding a full scan of 30 days of
   * files for callers that only need a small window of recent context.
   */
  private async readRecentLines(arc: string, maxDays = 30, maxLines?: number): Promise<JsonlLine[]> {
    const dir = join(this.arcsBasePath, arc, "chat_history");

    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }

    // Limit to maxDays most-recent files
    const recent = files.slice(-maxDays);

    if (maxLines !== undefined) {
      // Read newest files first; collect chunks until we have enough lines.
      const chunks: JsonlLine[][] = [];
      let total = 0;
      for (let i = recent.length - 1; i >= 0 && total < maxLines; i--) {
        const fileLines = await this.readJsonlFile(join(dir, recent[i]));
        chunks.push(fileLines);
        total += fileLines.length;
      }
      // Reverse so result is chronological, then trim to maxLines
      return chunks.reverse().flat().slice(-maxLines);
    }

    // No limit: read all files in chronological order
    const allLines: JsonlLine[] = [];
    for (const file of recent) {
      allLines.push(...(await this.readJsonlFile(join(dir, file))));
    }
    return allLines;
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


  // ── Thread context algorithm ──

  /**
   * selectThreadContext scans backwards through `lines` to collect:
   * 1. The thread starter (pid === threadId, no foreign tid)
   * 2. All thread replies (tid === threadId)
   * 3. Pre-starter main-channel messages (for context up to inferenceLimit)
   *
   * It naturally benefits from `readRecentLines` being called without a
   * maxLines cap (full history), since the thread starter may be arbitrarily
   * far back. The backward scan is already O(n) and stops once limit is met.
   */
  private selectThreadContext(
    lines: JsonlLine[],
    threadId: string,
    limit: number,
  ): JsonlLine[] {
    const result: JsonlLine[] = [];
    let foundStarter = false;
    let starterTs: string | null = null;

    // Scan backwards
    for (let i = lines.length - 1; i >= 0 && result.length < limit; i--) {
      const line = lines[i];

      // Check starter BEFORE thread membership — when tid===pid===threadId
      // (Slack auto-thread), the line must be recognized as the starter,
      // not consumed as an ordinary thread reply.
      if (
        !foundStarter &&
        line.pid === threadId &&
        (!line.tid || line.tid === line.pid)
      ) {
        result.push(line);
        foundStarter = true;
        starterTs = line.ts;
        continue;
      }

      // Collect thread messages (tid matches) — both before and after finding starter.
      if (line.tid === threadId) {
        result.push(line);
        continue;
      }

      if (!foundStarter) {
        // Skip unrelated main-channel messages until we find starter
        continue;
      }

      // In main-channel mode: collect non-threaded messages before the starter
      if (!line.tid && line.ts <= starterTs!) {
        result.push(line);
      }
    }

    return this.dedupeEdits(result.reverse());
  }

  /**
   * When multiple lines share the same pid AND role, keep the latest (edit dedup).
   * Different roles with the same pid are independent — a user message and an
   * assistant response may legitimately share a platformId (e.g. deliverResult
   * cloning the triggering message).
   */
  private dedupeEdits(lines: JsonlLine[]): JsonlLine[] {
    // Build a map of (pid, role) -> latest line index
    const keyLatest = new Map<string, number>();
    for (let i = lines.length - 1; i >= 0; i--) {
      const pid = lines[i].pid;
      if (!pid) continue;
      const key = `${pid}\0${lines[i].r ?? "user"}`;
      if (!keyLatest.has(key)) {
        keyLatest.set(key, i);
      }
    }

    return lines.filter((line, i) => {
      if (!line.pid) return true;
      const key = `${line.pid}\0${line.r ?? "user"}`;
      return keyLatest.get(key) === i;
    });
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
