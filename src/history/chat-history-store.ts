import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import type { AssistantMessage, Message, UserMessage } from "@mariozechner/pi-ai";

import { requireLastID, migrateAddColumn } from "../utils/index.js";
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

export interface LlmCallInput {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  callType?: string | null;
  arcName?: string | null;
  triggerMessageId?: number | null;
}

export interface HistoryMessageRow {
  id: number;
  nick: string;
  message: string;
  role: ChatRole;
  timestamp: string;
}

export interface LlmCallRow {
  id: number;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  callType: string | null;
  arcName: string | null;
  triggerMessageId: number | null;
  responseMessageId: number | null;
}

interface ContextRow {
  message: string;
  role: ChatRole;
  time_only: string;
  timestamp: string;
  mode: string | null;
}

interface FullHistoryRow {
  id: number;
  nick: string;
  message: string;
  role: ChatRole;
  timestamp: string;
}

interface RecentMessageDbRow {
  message: string;
  timestamp: string;
}

interface LlmCallDbRow {
  id: number;
  provider: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  call_type: string | null;
  arc_name: string | null;
  trigger_message_id: number | null;
  response_message_id: number | null;
}

export class ChatHistoryStore {
  private readonly dbPath: string;
  private readonly inferenceLimit: number;
  private db: Database | null = null;

  constructor(dbPath: string, inferenceLimit = 5) {
    this.dbPath = dbPath;
    this.inferenceLimit = inferenceLimit;
  }

  async initialize(): Promise<void> {
    if (!this.db) {
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database,
      });
    }

    const db = this.requireDb();

    await db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_tag TEXT NOT NULL,
          channel_name TEXT NOT NULL,
          nick TEXT NOT NULL,
          message TEXT NOT NULL,
          role TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          chapter_id INTEGER NULL,
          mode TEXT NULL,
          llm_call_id INTEGER NULL,
          platform_id TEXT NULL,
          thread_id TEXT NULL
      );

      CREATE TABLE IF NOT EXISTS llm_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost REAL,
          call_type TEXT,
          arc_name TEXT,
          trigger_message_id INTEGER NULL,
          response_message_id INTEGER NULL
      );

      CREATE INDEX IF NOT EXISTS idx_server_channel
      ON chat_messages (server_tag, channel_name, timestamp);

      CREATE INDEX IF NOT EXISTS idx_chapter_id
      ON chat_messages (chapter_id);

      CREATE INDEX IF NOT EXISTS idx_llm_calls_arc
      ON llm_calls (arc_name, timestamp);

      CREATE INDEX IF NOT EXISTS idx_platform_id
      ON chat_messages (server_tag, channel_name, platform_id);
    `);

    await this.migrateChatMessagesTable();
    await this.migrateLlmCallsTable();
  }

  async close(): Promise<void> {
    if (!this.db) {
      return;
    }

    await this.db.close();
    this.db = null;
  }

  async logLlmCall(input: LlmCallInput): Promise<number> {
    const db = this.requireDb();

    const result = await db.run(
      `
      INSERT INTO llm_calls
      (provider, model, input_tokens, output_tokens, cost, call_type, arc_name, trigger_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      input.provider,
      input.model,
      input.inputTokens,
      input.outputTokens,
      input.cost,
      input.callType ?? null,
      input.arcName ?? null,
      input.triggerMessageId ?? null,
    );

    return requireLastID(result);
  }

  async updateLlmCallResponse(callId: number, responseMessageId: number): Promise<void> {
    const db = this.requireDb();
    await db.run(
      "UPDATE llm_calls SET response_message_id = ? WHERE id = ?",
      responseMessageId,
      callId,
    );
  }

  async addMessage(
    message: RoomMessage,
    options: {
      mode?: string | null;
      llmCallId?: number | null;
      contentTemplate?: string;
      role?: ChatRole;
    } = {},
  ): Promise<number> {
    const db = this.requireDb();

    const role = options.role ?? this.defaultRoleForMessage(message);
    const contentTemplate = options.contentTemplate ?? "<{nick}> {message}";
    const content = contentTemplate
      .replace("{nick}", message.nick)
      .replace("{message}", message.content);

    const result = await db.run(
      `
      INSERT INTO chat_messages
      (server_tag, channel_name, nick, message, role, mode, llm_call_id, platform_id, thread_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      message.serverTag,
      message.channelName,
      message.nick,
      content,
      role,
      options.mode ?? null,
      options.llmCallId ?? null,
      message.platformId ?? null,
      message.responseThreadId ?? message.threadId ?? null,
    );

    return requireLastID(result);
  }

  async getContextForMessage(
    message: RoomMessage,
    limit?: number,
  ): Promise<Message[]> {
    return this.getContext(
      message.serverTag,
      message.channelName,
      limit,
      message.threadId,
      message.threadStarterId,
    );
  }

  async getContext(
    serverTag: string,
    channelName: string,
    limit?: number,
    threadId?: string,
    threadStarterId?: number,
  ): Promise<Message[]> {
    const db = this.requireDb();
    const inferenceLimit = limit ?? this.inferenceLimit;

    let rows: ContextRow[];

    if (threadId) {
      if (threadStarterId !== undefined) {
        rows = await db.all<ContextRow[]>(
          `
          SELECT message, role, strftime('%H:%M', timestamp) as time_only, timestamp, mode
          FROM chat_messages
          WHERE server_tag = ? AND channel_name = ?
          AND ((thread_id IS NULL AND id <= ?) OR thread_id = ?)
          ORDER BY id DESC
          LIMIT ?
          `,
          serverTag,
          channelName,
          threadStarterId,
          threadId,
          inferenceLimit,
        );
      } else {
        rows = await db.all<ContextRow[]>(
          `
          SELECT message, role, strftime('%H:%M', timestamp) as time_only, timestamp, mode
          FROM chat_messages
          WHERE server_tag = ? AND channel_name = ?
          AND (thread_id IS NULL OR thread_id = ?)
          ORDER BY id DESC
          LIMIT ?
          `,
          serverTag,
          channelName,
          threadId,
          inferenceLimit,
        );
      }
    } else {
      rows = await db.all<ContextRow[]>(
        `
        SELECT message, role, strftime('%H:%M', timestamp) as time_only, timestamp, mode
        FROM chat_messages
        WHERE server_tag = ? AND channel_name = ? AND thread_id IS NULL
        ORDER BY timestamp DESC
        LIMIT ?
        `,
        serverTag,
        channelName,
        inferenceLimit,
      );
    }

    return rows
      .slice()
      .reverse()
      .map((row): Message => {
        const modePrefix = row.role === "assistant" && row.mode ? this.modeToPrefix(row.mode) : "";
        const text = `${modePrefix}[${row.time_only}] ${row.message}`;
        const timestamp = new Date(row.timestamp + "Z").getTime() || 0;
        if (row.role === "assistant") {
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
    serverTag: string,
    channelName: string,
    limit?: number,
  ): Promise<HistoryMessageRow[]> {
    const db = this.requireDb();

    const rows =
      limit !== undefined
        ? await db.all<FullHistoryRow[]>(
            `
            SELECT id, nick, message, role, timestamp FROM chat_messages
            WHERE server_tag = ? AND channel_name = ?
            ORDER BY timestamp DESC
            LIMIT ?
            `,
            serverTag,
            channelName,
            limit,
          )
        : await db.all<FullHistoryRow[]>(
            `
            SELECT id, nick, message, role, timestamp FROM chat_messages
            WHERE server_tag = ? AND channel_name = ?
            ORDER BY timestamp DESC
            `,
            serverTag,
            channelName,
          );

    return rows.slice().reverse().map((row) => ({
      id: Number(row.id),
      nick: String(row.nick),
      message: String(row.message),
      role: String(row.role) as ChatRole,
      timestamp: String(row.timestamp),
    }));
  }

  async getRecentMessagesSince(
    serverTag: string,
    channelName: string,
    nick: string,
    timestamp: number,
    threadId?: string,
  ): Promise<Array<{ message: string; timestamp: string }>> {
    const db = this.requireDb();
    const sinceEpochSeconds = String(Math.trunc(timestamp));

    const rows = threadId
      ? await db.all<RecentMessageDbRow[]>(
          `
          SELECT message, timestamp FROM chat_messages
          WHERE server_tag = ? AND channel_name = ? AND nick = ?
          AND strftime('%s', timestamp) > ? AND thread_id = ?
          ORDER BY timestamp ASC
          `,
          serverTag,
          channelName,
          nick,
          sinceEpochSeconds,
          threadId,
        )
      : await db.all<RecentMessageDbRow[]>(
          `
          SELECT message, timestamp FROM chat_messages
          WHERE server_tag = ? AND channel_name = ? AND nick = ?
          AND strftime('%s', timestamp) > ? AND thread_id IS NULL
          ORDER BY timestamp ASC
          `,
          serverTag,
          channelName,
          nick,
          sinceEpochSeconds,
        );

    return rows.flatMap((row) => {
      const content = String(row.message);
      const splitIndex = content.indexOf("> ");
      if (splitIndex < 0) {
        return [];
      }

      return [
        {
          message: content.slice(splitIndex + 2),
          timestamp: String(row.timestamp),
        },
      ];
    });
  }

  /**
   * Count messages in a channel since the given epoch timestamp (ms).
   * Used by proactive debounce to detect silence.
   */
  async countMessagesSince(serverTag: string, channelName: string, sinceEpochMs: number): Promise<number> {
    const db = this.requireDb();
    const isoTimestamp = new Date(sinceEpochMs).toISOString();

    const row = await db.get<{ count: number }>(
      `
      SELECT COUNT(*) as count FROM chat_messages
      WHERE server_tag = ? AND channel_name = ?
      AND timestamp >= ?
      `,
      serverTag,
      channelName,
      isoTimestamp,
    );

    return Number(row?.count ?? 0);
  }

  async countRecentUnchronicled(serverTag: string, channelName: string, days = 7): Promise<number> {
    const db = this.requireDb();

    const row = await db.get<{ count: number }>(
      `
      SELECT COUNT(*) as count FROM chat_messages
      WHERE server_tag = ? AND channel_name = ?
      AND chapter_id IS NULL
      AND timestamp >= datetime('now', '-' || ? || ' days')
      `,
      serverTag,
      channelName,
      days,
    );

    return Number(row?.count ?? 0);
  }

  async markChronicled(messageIds: number[], chapterId: number): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const db = this.requireDb();
    const placeholders = messageIds.map(() => "?").join(",");
    await db.run(
      `UPDATE chat_messages SET chapter_id = ? WHERE id IN (${placeholders})`,
      chapterId,
      ...messageIds,
    );
  }

  async getArcCostToday(arcName: string): Promise<number> {
    const db = this.requireDb();
    const row = await db.get<{ total: number }>(
      `
      SELECT COALESCE(SUM(cost), 0) as total FROM llm_calls
      WHERE arc_name = ?
      AND timestamp >= date('now')
      `,
      arcName,
    );
    return Number(row?.total ?? 0);
  }

  async getLlmCalls(limit?: number): Promise<LlmCallRow[]> {
    const db = this.requireDb();
    const rows =
      limit !== undefined
        ? await db.all<LlmCallDbRow[]>(
            `
            SELECT id, provider, model, input_tokens, output_tokens, cost, call_type,
                   arc_name, trigger_message_id, response_message_id
            FROM llm_calls
            ORDER BY id ASC
            LIMIT ?
            `,
            limit,
          )
        : await db.all<LlmCallDbRow[]>(
            `
            SELECT id, provider, model, input_tokens, output_tokens, cost, call_type,
                   arc_name, trigger_message_id, response_message_id
            FROM llm_calls
            ORDER BY id ASC
            `,
          );

    return rows.map((row) => ({
      id: Number(row.id),
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cost: row.cost,
      callType: row.call_type,
      arcName: row.arc_name,
      triggerMessageId: row.trigger_message_id,
      responseMessageId: row.response_message_id,
    }));
  }

  async getMessageIdByPlatformId(
    serverTag: string,
    channelName: string,
    platformId: string,
  ): Promise<number | null> {
    const db = this.requireDb();

    const row = await db.get<{ id: number }>(
      `
      SELECT id FROM chat_messages
      WHERE server_tag = ? AND channel_name = ? AND platform_id = ?
      LIMIT 1
      `,
      serverTag,
      channelName,
      platformId,
    );

    return row ? Number(row.id) : null;
  }

  async updateMessageByPlatformId(
    serverTag: string,
    channelName: string,
    platformId: string,
    newContent: string,
    nick: string,
    contentTemplate = "<{nick}> {message}",
  ): Promise<boolean> {
    const db = this.requireDb();
    const formatted = contentTemplate.replace("{nick}", nick).replace("{message}", newContent);

    const result = await db.run(
      `
      UPDATE chat_messages
      SET message = ?
      WHERE server_tag = ? AND channel_name = ? AND platform_id = ?
      `,
      formatted,
      serverTag,
      channelName,
      platformId,
    );

    return Number(result.changes ?? 0) > 0;
  }

  private defaultRoleForMessage(message: RoomMessage): ChatRole {
    return message.nick.toLowerCase() === message.mynick.toLowerCase() ? "assistant" : "user";
  }

  private modeToPrefix(mode: string): string {
    if (!mode) {
      return "";
    }
    if (mode.startsWith("!")) {
      return `${mode} `;
    }
    return "";
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error("ChatHistoryStore not initialized. Call initialize() first.");
    }
    return this.db;
  }

  private async migrateChatMessagesTable(): Promise<void> {
    const db = this.requireDb();
    await migrateAddColumn(db, "chat_messages", "mode", "TEXT NULL");
    await migrateAddColumn(db, "chat_messages", "llm_call_id", "INTEGER NULL");
    await migrateAddColumn(db, "chat_messages", "platform_id", "TEXT NULL");
    await migrateAddColumn(db, "chat_messages", "thread_id", "TEXT NULL");
  }

  private async migrateLlmCallsTable(): Promise<void> {
    const db = this.requireDb();
    await migrateAddColumn(db, "llm_calls", "trigger_message_id", "INTEGER NULL");
    const added = await migrateAddColumn(db, "llm_calls", "response_message_id", "INTEGER NULL");
    if (added) {
      await db.exec(`
        UPDATE llm_calls SET response_message_id = (
          SELECT id FROM chat_messages WHERE llm_call_id = llm_calls.id LIMIT 1
        ) WHERE response_message_id IS NULL
      `);
    }
  }
}
