import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
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
    const lines = this.readRecentLines(arc);

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
    const lines = this.readRecentLines(arc);
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
   */
  async countMessagesSince(arc: string, sinceEpochMs: number): Promise<number> {
    const sinceTs = new Date(sinceEpochMs).toISOString();
    const todayFile = this.jsonlPath(arc, this.todayDate());
    if (!existsSync(todayFile)) return 0;

    const lines = this.readJsonlFile(todayFile);
    return lines.filter((l) => l.m !== undefined && l.ts >= sinceTs).length;
  }

  async countRecentUnchronicled(arc: string, days = 7): Promise<number> {
    const cursor = this.readCursorTs(arc);
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const effectiveCutoff = cursor && cursor > cutoff ? cursor : cutoff;

    const lines = this.readRecentLines(arc, days);
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
    if (!existsSync(todayFile)) return 0;

    const lines = this.readJsonlFile(todayFile);
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
  async appendEdit(arc: string, pid: string, content: string, nick: string): Promise<void> {
    const line: JsonlLine = {
      ts: new Date().toISOString(),
      n: nick,
      r: "user",
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
    mkdirSync(join(this.arcsBasePath, arc, "chat_history"), { recursive: true });
    appendFileSync(filePath, JSON.stringify(line) + "\n", "utf-8");
  }

  private readJsonlFile(path: string): JsonlLine[] {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf-8");
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

  /** Read lines from today backwards, concatenated in chronological order. */
  private readRecentLines(arc: string, maxDays = 30): JsonlLine[] {
    const dir = join(this.arcsBasePath, arc, "chat_history");
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();

    // Only read last maxDays files
    const recent = files.slice(-maxDays);
    const allLines: JsonlLine[] = [];
    for (const file of recent) {
      allLines.push(...this.readJsonlFile(join(dir, file)));
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

  private readCursorTs(arc: string): string | null {
    const path = this.cursorPath(arc);
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      return data.ts ?? null;
    } catch {
      return null;
    }
  }


  // ── Thread context algorithm ──

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

      if (!foundStarter) {
        // Collect thread messages
        if (line.tid === threadId) {
          result.push(line);
          continue;
        }
        // Check if this is the thread starter (pid matches threadId, not a thread message itself)
        if (line.pid === threadId && !line.tid) {
          result.push(line);
          foundStarter = true;
          starterTs = line.ts;
          continue;
        }
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

  /** When multiple lines share the same pid, keep the latest (edit dedup). */
  private dedupeEdits(lines: JsonlLine[]): JsonlLine[] {
    // Build a map of pid -> latest line index
    const pidLatest = new Map<string, number>();
    for (let i = lines.length - 1; i >= 0; i--) {
      const pid = lines[i].pid;
      if (pid && !pidLatest.has(pid)) {
        pidLatest.set(pid, i);
      }
    }

    return lines.filter((line, i) => {
      if (!line.pid) return true;
      return pidLatest.get(line.pid) === i;
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
