import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, UserMessage } from "@mariozechner/pi-ai";

export interface Chapter {
  number: number;
  openedAt: string;
  closedAt: string | null;
  summary: string | null;
}

interface ParsedChapter {
  openedAt: string;
  closedAt: string | null;
  summary: string | null;
  paragraphs: Array<{ ts: string; content: string }>;
}

export class ChronicleStore {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async initialize(): Promise<void> {
    mkdirSync(this.basePath, { recursive: true });
  }

  async close(): Promise<void> {
    // no-op for filesystem store
  }

  async getOrOpenCurrentChapter(arc: string): Promise<Chapter> {
    const dir = this.arcDir(arc);
    mkdirSync(dir, { recursive: true });

    const files = this.listChapterFiles(arc);
    if (files.length > 0) {
      const lastFile = files[files.length - 1];
      const parsed = this.parseChapterFile(join(dir, lastFile));
      if (!parsed.closedAt) {
        return {
          number: this.chapterNumberFromFilename(lastFile),
          openedAt: parsed.openedAt,
          closedAt: null,
          summary: null,
        };
      }
    }

    // Open a new chapter
    const nextNumber = files.length > 0
      ? this.chapterNumberFromFilename(files[files.length - 1]) + 1
      : 1;
    const isNewArc = files.length === 0;
    const now = new Date().toISOString();
    const chapter: Chapter = {
      number: nextNumber,
      openedAt: now,
      closedAt: null,
      summary: null,
    };
    this.writeChapterFile(join(dir, this.chapterFilename(nextNumber)), chapter, []);

    if (isNewArc) {
      await this.appendParagraph(arc, "<meta>This is a beginning of an entirely new story arc!</meta>");
    }

    return chapter;
  }

  async appendParagraph(arc: string, content: string): Promise<{ chapter_number: number; ts: string; content: string }> {
    if (!content.trim()) {
      throw new Error("content must be non-empty");
    }

    const chapter = await this.getOrOpenCurrentChapter(arc);
    const dir = this.arcDir(arc);
    const filePath = join(dir, this.chapterFilename(chapter.number));
    const parsed = this.parseChapterFile(filePath);

    const ts = new Date().toISOString();
    parsed.paragraphs.push({ ts, content });
    this.writeChapterFile(filePath, chapter, parsed.paragraphs);

    return { chapter_number: chapter.number, ts, content };
  }

  async countParagraphsInChapter(chapterNumber: number, arc: string): Promise<number> {
    const dir = this.arcDir(arc);
    const filePath = join(dir, this.chapterFilename(chapterNumber));
    if (!existsSync(filePath)) {
      return 0;
    }
    const parsed = this.parseChapterFile(filePath);
    return parsed.paragraphs.length;
  }

  async closeChapterWithSummary(chapterNumber: number, arc: string, summary: string): Promise<void> {
    const dir = this.arcDir(arc);
    const filePath = join(dir, this.chapterFilename(chapterNumber));
    const parsed = this.parseChapterFile(filePath);

    const chapter: Chapter = {
      number: chapterNumber,
      openedAt: parsed.openedAt,
      closedAt: new Date().toISOString(),
      summary,
    };
    this.writeChapterFile(filePath, chapter, parsed.paragraphs);
  }

  async readChapter(chapterNumber: number, arc: string): Promise<string[]> {
    const dir = this.arcDir(arc);
    const filePath = join(dir, this.chapterFilename(chapterNumber));
    if (!existsSync(filePath)) {
      return [];
    }
    const parsed = this.parseChapterFile(filePath);
    return parsed.paragraphs.map((p) => p.content);
  }

  async getChapterContextMessages(arc: string): Promise<Message[]> {
    const chapter = await this.getOrOpenCurrentChapter(arc);
    const dir = this.arcDir(arc);
    const filePath = join(dir, this.chapterFilename(chapter.number));
    const parsed = this.parseChapterFile(filePath);

    return parsed.paragraphs.map((p): UserMessage => ({
      role: "user",
      content: `<context_summary>${p.content}</context_summary>`,
      timestamp: new Date(p.ts).getTime() || 0,
    }));
  }

  /**
   * Read all chapter files for an arc. Returns an array of { number, content }
   * where content is the raw markdown string. Used for gondolin VM mounting.
   */
  readAllChapterFiles(arc: string): Array<{ filename: string; content: string }> {
    const dir = this.arcDir(arc);
    if (!existsSync(dir)) {
      return [];
    }
    const files = this.listChapterFiles(arc);
    return files.map((filename) => ({
      filename,
      content: readFileSync(join(dir, filename), "utf-8"),
    }));
  }

  // ── Internal helpers ──

  private arcDir(arc: string): string {
    return join(this.basePath, arc);
  }

  private chapterFilename(number: number): string {
    return `${String(number).padStart(6, "0")}.md`;
  }

  private chapterNumberFromFilename(filename: string): number {
    return parseInt(filename.replace(/\.md$/, ""), 10);
  }

  private listChapterFiles(arc: string): string[] {
    const dir = this.arcDir(arc);
    if (!existsSync(dir)) {
      return [];
    }
    return readdirSync(dir)
      .filter((f) => /^\d{6}\.md$/.test(f))
      .sort();
  }

  private parseChapterFile(filePath: string): ParsedChapter {
    const raw = readFileSync(filePath, "utf-8");
    return parseChapterMarkdown(raw);
  }

  private writeChapterFile(filePath: string, chapter: Chapter, paragraphs: Array<{ ts: string; content: string }>): void {
    const lines: string[] = ["---"];
    lines.push(`openedAt: "${chapter.openedAt}"`);
    if (chapter.closedAt) {
      lines.push(`closedAt: "${chapter.closedAt}"`);
    }
    if (chapter.summary) {
      lines.push(`summary: ${JSON.stringify(chapter.summary)}`);
    }
    lines.push("---");
    lines.push("");

    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      const tsPrefix = p.ts.slice(0, 16).replace("T", " "); // YYYY-MM-DD HH:MM
      lines.push(`[${tsPrefix}] ${p.content}`);
      if (i < paragraphs.length - 1) {
        lines.push("");
      }
    }

    const content = lines.join("\n") + "\n";
    const tmpPath = filePath + ".tmp";
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  }
}

// ── Frontmatter parser (no YAML library) ──

function parseChapterMarkdown(raw: string): ParsedChapter {
  let openedAt = new Date().toISOString();
  let closedAt: string | null = null;
  let summary: string | null = null;
  const paragraphs: Array<{ ts: string; content: string }> = [];

  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  let body = raw;

  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    body = raw.slice(frontmatterMatch[0].length);

    const openedAtMatch = frontmatter.match(/^openedAt:\s*"(.+)"/m);
    if (openedAtMatch) {
      openedAt = openedAtMatch[1];
    }

    const closedAtMatch = frontmatter.match(/^closedAt:\s*"(.+)"/m);
    if (closedAtMatch) {
      closedAt = closedAtMatch[1];
    }

    const summaryMatch = frontmatter.match(/^summary:\s*(.+)/m);
    if (summaryMatch) {
      const rawSummary = summaryMatch[1].trim();
      // Handle JSON-quoted strings
      if (rawSummary.startsWith('"') && rawSummary.endsWith('"')) {
        try {
          summary = JSON.parse(rawSummary);
        } catch {
          summary = rawSummary.slice(1, -1);
        }
      } else {
        summary = rawSummary;
      }
    }
  }

  // Parse paragraphs from body
  const paragraphBlocks = body.split(/\n\n+/).filter((block) => block.trim());
  for (const block of paragraphBlocks) {
    const match = block.trim().match(/^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})\]\s+([\s\S]+)$/);
    if (match) {
      paragraphs.push({
        ts: match[1] + ":00.000Z",
        content: match[2].trim(),
      });
    }
  }

  return { openedAt, closedAt, summary, paragraphs };
}
