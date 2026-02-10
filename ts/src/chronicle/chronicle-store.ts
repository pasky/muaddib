import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";

export interface Chapter {
  id: number;
  arcId: number;
  openedAt: string;
  closedAt: string | null;
  metaJson: string | null;
}

interface ParagraphRow {
  id: number;
  chapter_id: number;
  ts: string;
  content: string;
}

export class ChronicleStore {
  private readonly dbPath: string;
  private db: Database | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
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
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS arcs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        arc_id INTEGER NOT NULL,
        opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME,
        meta_json TEXT,
        FOREIGN KEY (arc_id) REFERENCES arcs(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_chapters_arc_open
      ON chapters(arc_id)
      WHERE closed_at IS NULL;

      CREATE TABLE IF NOT EXISTS paragraphs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_id INTEGER NOT NULL,
        ts DATETIME DEFAULT CURRENT_TIMESTAMP,
        content TEXT NOT NULL,
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_paragraphs_chapter_ts
      ON paragraphs(chapter_id, ts);

      CREATE INDEX IF NOT EXISTS idx_chapters_arc_opened
      ON chapters(arc_id, opened_at);
    `);
  }

  async close(): Promise<void> {
    if (!this.db) {
      return;
    }

    await this.db.close();
    this.db = null;
  }

  async getOrOpenCurrentChapter(arc: string): Promise<Chapter> {
    const [arcId, isNewArc] = await this.getOrCreateArc(arc);

    let chapter = await this.getOpenChapter(arcId);
    if (!chapter) {
      chapter = await this.openNewChapter(arcId);
    }

    if (isNewArc) {
      await this.appendParagraph(arc, "<meta>This is a beginning of an entirely new story arc!</meta>");
    }

    return chapter;
  }

  async appendParagraph(arc: string, content: string): Promise<ParagraphRow> {
    if (!content.trim()) {
      throw new Error("content must be non-empty");
    }

    const db = this.requireDb();
    const chapter = await this.getOrOpenCurrentChapter(arc);

    const result = await db.run(
      "INSERT INTO paragraphs(chapter_id, content) VALUES (?, ?)",
      chapter.id,
      content,
    );

    const row = await db.get<ParagraphRow>(
      "SELECT id, chapter_id, ts, content FROM paragraphs WHERE id = ?",
      Number(result.lastID ?? 0),
    );

    if (!row) {
      throw new Error("Failed to load inserted paragraph.");
    }

    return row;
  }

  async readChapter(chapterId: number): Promise<string[]> {
    const db = this.requireDb();
    const rows = await db.all<Array<{ content: string }>>(
      "SELECT content FROM paragraphs WHERE chapter_id = ? ORDER BY ts ASC",
      chapterId,
    );

    return rows.map((row) => row.content);
  }

  async getChapterContextMessages(arc: string): Promise<Array<{ role: "user"; content: string }>> {
    const chapter = await this.getOrOpenCurrentChapter(arc);
    const paragraphs = await this.readChapter(chapter.id);

    return paragraphs.map((paragraph) => ({
      role: "user" as const,
      content: `<context_summary>${paragraph}</context_summary>`,
    }));
  }

  async renderChapter(arc: string, chapterId?: number, lastN?: number): Promise<string> {
    const resolvedChapter = await this.resolveChapter(arc, chapterId);
    if (!resolvedChapter) {
      return `# Arc: ${arc} — No chapters yet\n\n(Empty)`;
    }

    const db = this.requireDb();
    const rows = await db.all<Array<{ ts: string; content: string }>>(
      "SELECT ts, content FROM paragraphs WHERE chapter_id = ? ORDER BY ts ASC",
      resolvedChapter.id,
    );

    const selectedRows = lastN && lastN > 0 ? rows.slice(-lastN) : rows;

    let title = `# Arc: ${arc} — Chapter ${resolvedChapter.id} (opened ${resolvedChapter.openedAt.split(".")[0]})`;
    if (resolvedChapter.closedAt) {
      title += `, closed ${resolvedChapter.closedAt.split(".")[0]}`;
    }

    const lines = [title, "", "Paragraphs:"];
    for (const row of selectedRows) {
      const hhmm = row.ts.length >= 16 ? row.ts.slice(11, 16) : row.ts;
      lines.push(`[${hhmm}] ${row.content}`);
    }

    if (selectedRows.length === 0) {
      lines.push("(No paragraphs)");
    }

    return lines.join("\n");
  }

  private async getOrCreateArc(arc: string): Promise<[number, boolean]> {
    const db = this.requireDb();
    const existing = await db.get<{ id: number }>("SELECT id FROM arcs WHERE name = ?", arc);
    if (existing) {
      return [Number(existing.id), false];
    }

    const result = await db.run("INSERT INTO arcs(name) VALUES (?)", arc);
    return [Number(result.lastID ?? 0), true];
  }

  private async getOpenChapter(arcId: number): Promise<Chapter | null> {
    const db = this.requireDb();
    const row = await db.get<{
      id: number;
      arc_id: number;
      opened_at: string;
      closed_at: string | null;
      meta_json: string | null;
    }>(
      `
      SELECT id, arc_id, opened_at, closed_at, meta_json
      FROM chapters
      WHERE arc_id = ? AND closed_at IS NULL
      `,
      arcId,
    );

    if (!row) {
      return null;
    }

    return {
      id: Number(row.id),
      arcId: Number(row.arc_id),
      openedAt: String(row.opened_at),
      closedAt: row.closed_at,
      metaJson: row.meta_json,
    };
  }

  private async openNewChapter(arcId: number): Promise<Chapter> {
    const db = this.requireDb();
    const result = await db.run("INSERT INTO chapters(arc_id) VALUES (?)", arcId);

    const row = await db.get<{
      id: number;
      arc_id: number;
      opened_at: string;
      closed_at: string | null;
      meta_json: string | null;
    }>(
      "SELECT id, arc_id, opened_at, closed_at, meta_json FROM chapters WHERE id = ?",
      Number(result.lastID ?? 0),
    );

    if (!row) {
      throw new Error("Failed to open chapter.");
    }

    return {
      id: Number(row.id),
      arcId: Number(row.arc_id),
      openedAt: String(row.opened_at),
      closedAt: row.closed_at,
      metaJson: row.meta_json,
    };
  }

  private async resolveChapter(arc: string, chapterId?: number): Promise<Chapter | null> {
    const db = this.requireDb();
    const [arcId] = await this.getOrCreateArc(arc);

    if (chapterId !== undefined) {
      const row = await db.get<{
        id: number;
        arc_id: number;
        opened_at: string;
        closed_at: string | null;
        meta_json: string | null;
      }>(
        `
        SELECT id, arc_id, opened_at, closed_at, meta_json
        FROM chapters
        WHERE id = ? AND arc_id = ?
        `,
        chapterId,
        arcId,
      );

      if (!row) {
        return null;
      }

      return {
        id: Number(row.id),
        arcId: Number(row.arc_id),
        openedAt: String(row.opened_at),
        closedAt: row.closed_at,
        metaJson: row.meta_json,
      };
    }

    const open = await this.getOpenChapter(arcId);
    if (open) {
      return open;
    }

    const latest = await db.get<{
      id: number;
      arc_id: number;
      opened_at: string;
      closed_at: string | null;
      meta_json: string | null;
    }>(
      `
      SELECT id, arc_id, opened_at, closed_at, meta_json
      FROM chapters
      WHERE arc_id = ?
      ORDER BY opened_at DESC
      LIMIT 1
      `,
      arcId,
    );

    if (!latest) {
      return null;
    }

    return {
      id: Number(latest.id),
      arcId: Number(latest.arc_id),
      openedAt: String(latest.opened_at),
      closedAt: latest.closed_at,
      metaJson: latest.meta_json,
    };
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error("ChronicleStore not initialized. Call initialize() first.");
    }
    return this.db;
  }
}
