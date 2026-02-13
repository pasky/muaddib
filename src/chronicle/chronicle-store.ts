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

export type QuestStatus = "ongoing" | "in_step" | "finished";

export interface QuestRow {
  id: string;
  arc_id: number;
  parent_id: string | null;
  status: QuestStatus;
  last_state: string | null;
  plan: string | null;
  resume_at: string | null;
  created_by_paragraph_id: number | null;
  last_updated_by_paragraph_id: number | null;
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

      CREATE TABLE IF NOT EXISTS quests (
        id TEXT PRIMARY KEY,
        arc_id INTEGER NOT NULL,
        parent_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('ongoing', 'in_step', 'finished')),
        last_state TEXT,
        plan TEXT,
        resume_at TEXT,
        created_by_paragraph_id INTEGER,
        last_updated_by_paragraph_id INTEGER,
        FOREIGN KEY (arc_id) REFERENCES arcs(id),
        FOREIGN KEY (parent_id) REFERENCES quests(id),
        FOREIGN KEY (created_by_paragraph_id) REFERENCES paragraphs(id),
        FOREIGN KEY (last_updated_by_paragraph_id) REFERENCES paragraphs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_quests_arc_status
      ON quests(arc_id, status);

      CREATE INDEX IF NOT EXISTS idx_quests_parent
      ON quests(parent_id);
    `);

    const questColumns = await db.all<Array<{ name: string }>>("PRAGMA table_info(quests)");
    const hasResumeAt = questColumns.some((column) => column.name === "resume_at");
    if (!hasResumeAt) {
      await db.exec("ALTER TABLE quests ADD COLUMN resume_at TEXT");
    }
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

  async countParagraphsInChapter(chapterId: number): Promise<number> {
    const db = this.requireDb();
    const row = await db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM paragraphs WHERE chapter_id = ?",
      chapterId,
    );

    return Number(row?.count ?? 0);
  }

  async closeChapterWithSummary(chapterId: number, summary: string): Promise<void> {
    const db = this.requireDb();
    const metaJson = JSON.stringify({ summary });

    await db.run(
      "UPDATE chapters SET closed_at = CURRENT_TIMESTAMP, meta_json = ? WHERE id = ?",
      metaJson,
      chapterId,
    );
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

  async questStart(
    questId: string,
    arc: string,
    paragraphId: number,
    stateText: string,
    parentId: string | null = null,
  ): Promise<void> {
    const db = this.requireDb();
    const [arcId] = await this.getOrCreateArc(arc);

    await db.run(
      `INSERT INTO quests
         (id, arc_id, parent_id, status, last_state, created_by_paragraph_id, last_updated_by_paragraph_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      questId,
      arcId,
      parentId,
      "ongoing",
      stateText,
      paragraphId,
      paragraphId,
    );
  }

  async questUpdate(questId: string, stateText: string, paragraphId: number): Promise<void> {
    const db = this.requireDb();
    await db.run(
      `UPDATE quests
       SET last_state = ?, last_updated_by_paragraph_id = ?
       WHERE id = ?`,
      stateText,
      paragraphId,
      questId,
    );
  }

  async questFinish(questId: string, paragraphId: number): Promise<void> {
    const db = this.requireDb();
    await db.run(
      `UPDATE quests
       SET status = ?, last_updated_by_paragraph_id = ?
       WHERE id = ?`,
      "finished",
      paragraphId,
      questId,
    );
  }

  async questSetStatus(questId: string, status: QuestStatus): Promise<void> {
    const db = this.requireDb();
    await db.run("UPDATE quests SET status = ? WHERE id = ?", status, questId);
  }

  async questTryTransition(
    questId: string,
    fromStatus: QuestStatus,
    toStatus: QuestStatus,
  ): Promise<boolean> {
    const db = this.requireDb();
    const result = await db.run(
      "UPDATE quests SET status = ? WHERE id = ? AND status = ?",
      toStatus,
      questId,
      fromStatus,
    );

    return Number(result.changes ?? 0) > 0;
  }

  async questGet(questId: string): Promise<QuestRow | null> {
    const db = this.requireDb();
    const row = await db.get<QuestRow>(
      `SELECT id, arc_id, parent_id, status, last_state, plan, resume_at,
              created_by_paragraph_id, last_updated_by_paragraph_id
       FROM quests
       WHERE id = ?`,
      questId,
    );

    return row ?? null;
  }

  async questSetPlan(questId: string, plan: string): Promise<boolean> {
    const db = this.requireDb();
    const result = await db.run("UPDATE quests SET plan = ? WHERE id = ?", plan, questId);
    return Number(result.changes ?? 0) > 0;
  }

  async questSetResumeAt(questId: string, resumeAt: string | null): Promise<boolean> {
    const db = this.requireDb();
    const result = await db.run(
      "UPDATE quests SET resume_at = ? WHERE id = ?",
      resumeAt,
      questId,
    );

    return Number(result.changes ?? 0) > 0;
  }

  async questsReadyForHeartbeat(arc: string, cooldownSeconds: number): Promise<QuestRow[]> {
    const db = this.requireDb();
    const [arcId] = await this.getOrCreateArc(arc);

    const rows = await db.all<QuestRow[]>(
      `SELECT q.id, q.arc_id, q.parent_id, q.status, q.last_state, q.plan, q.resume_at,
              q.created_by_paragraph_id, q.last_updated_by_paragraph_id
       FROM quests q
       JOIN paragraphs p ON q.last_updated_by_paragraph_id = p.id
       WHERE q.arc_id = ?
         AND q.status = ?
         AND datetime(p.ts, '+' || ? || ' seconds') <= datetime('now')
         AND (q.resume_at IS NULL OR datetime('now') >= datetime(q.resume_at))
         AND NOT EXISTS (
           SELECT 1 FROM quests c
           WHERE c.parent_id = q.id AND c.status IN (?, ?)
         )`,
      arcId,
      "ongoing",
      Math.max(0, Math.trunc(cooldownSeconds)),
      "ongoing",
      "in_step",
    );

    return rows;
  }

  async questsCountUnfinished(arc: string): Promise<number> {
    const db = this.requireDb();
    const [arcId] = await this.getOrCreateArc(arc);
    const row = await db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM quests WHERE arc_id = ? AND status != ?",
      arcId,
      "finished",
    );

    return Number(row?.count ?? 0);
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

  async renderChapterRelative(arc: string, relativeChapterId: number, lastN?: number): Promise<string> {
    if (!Number.isInteger(relativeChapterId)) {
      throw new Error("relativeChapterId must be an integer.");
    }

    const resolvedChapter = await this.resolveChapterRelative(arc, relativeChapterId);
    if (!resolvedChapter) {
      return `# Arc: ${arc} — No chapters at relative offset ${relativeChapterId}\n\n(Empty)`;
    }

    const db = this.requireDb();
    const rows = await db.all<Array<{ ts: string; content: string }>>(
      "SELECT ts, content FROM paragraphs WHERE chapter_id = ? ORDER BY ts ASC",
      resolvedChapter.id,
    );

    const selectedRows = lastN && lastN > 0 ? rows.slice(-lastN) : rows;

    const relativeDesc =
      relativeChapterId === 0
        ? "current"
        : `${Math.abs(relativeChapterId)} chapter${Math.abs(relativeChapterId) > 1 ? "s" : ""} ${relativeChapterId < 0 ? "back" : "forward"}`;

    let title = `# Arc: ${arc} — Chapter ${resolvedChapter.id} (${relativeDesc}, opened ${resolvedChapter.openedAt.split(".")[0]})`;
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

  private async resolveChapterRelative(arc: string, relativeChapterId: number): Promise<Chapter | null> {
    const db = this.requireDb();
    const [arcId] = await this.getOrCreateArc(arc);

    const rows = await db.all<
      Array<{
        id: number;
        arc_id: number;
        opened_at: string;
        closed_at: string | null;
        meta_json: string | null;
      }>
    >(
      `
      SELECT id, arc_id, opened_at, closed_at, meta_json
      FROM chapters
      WHERE arc_id = ?
      ORDER BY opened_at ASC
      `,
      arcId,
    );

    if (rows.length === 0) {
      return null;
    }

    const open = await this.getOpenChapter(arcId);
    const currentChapterId = open ? open.id : Number(rows[rows.length - 1].id);
    const chapterIds = rows.map((row) => Number(row.id));
    const currentIndex = chapterIds.indexOf(currentChapterId);

    if (currentIndex < 0) {
      return null;
    }

    const targetIndex = currentIndex + relativeChapterId;
    if (targetIndex < 0 || targetIndex >= chapterIds.length) {
      return null;
    }

    const targetChapterId = chapterIds[targetIndex];
    const targetRow = rows.find((row) => Number(row.id) === targetChapterId);
    if (!targetRow) {
      return null;
    }

    return {
      id: Number(targetRow.id),
      arcId: Number(targetRow.arc_id),
      openedAt: String(targetRow.opened_at),
      closedAt: targetRow.closed_at,
      metaJson: targetRow.meta_json,
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
