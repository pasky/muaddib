#!/usr/bin/env npx tsx
/**
 * Migrate chronicle data from SQLite (chronicle.db) to file-based markdown.
 *
 * Usage:
 *   npx tsx scripts/migrate-chronicle.ts [--db path] [--out path]
 *
 * Defaults:
 *   --db  $MUADDIB_HOME/chronicle.db
 *   --out $MUADDIB_HOME/chronicle/
 */

import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

async function main() {
  const args = process.argv.slice(2);
  const muaddibHome = process.env.MUADDIB_HOME
    ? resolve(process.env.MUADDIB_HOME)
    : join(homedir(), ".muaddib");

  let dbPath = join(muaddibHome, "chronicle.db");
  let outPath = join(muaddibHome, "chronicle");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && args[i + 1]) {
      dbPath = resolve(args[++i]);
    } else if (args[i] === "--out" && args[i + 1]) {
      outPath = resolve(args[++i]);
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      console.error("Usage: npx tsx scripts/migrate-chronicle.ts [--db path] [--out path]");
      process.exit(1);
    }
  }

  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  console.log(`Migrating: ${dbPath} → ${outPath}`);

  const { open } = await import("sqlite");
  const sqlite3 = (await import("sqlite3")).default;

  const db = await open({ filename: dbPath, driver: sqlite3.Database });

  // Read all arcs
  const arcs = await db.all<Array<{ id: number; name: string }>>(
    "SELECT id, name FROM arcs ORDER BY id",
  );

  let totalChapters = 0;
  let totalParagraphs = 0;

  for (const arc of arcs) {
    const arcDir = join(outPath, arc.name);
    mkdirSync(arcDir, { recursive: true });

    const chapters = await db.all<Array<{
      id: number;
      opened_at: string;
      closed_at: string | null;
      meta_json: string | null;
    }>>(
      "SELECT id, opened_at, closed_at, meta_json FROM chapters WHERE arc_id = ? ORDER BY opened_at ASC",
      arc.id,
    );

    let chapterNumber = 0;
    for (const chapter of chapters) {
      chapterNumber++;
      totalChapters++;

      const paragraphs = await db.all<Array<{ ts: string; content: string }>>(
        "SELECT ts, content FROM paragraphs WHERE chapter_id = ? ORDER BY ts ASC",
        chapter.id,
      );
      totalParagraphs += paragraphs.length;

      let summary: string | null = null;
      if (chapter.meta_json) {
        try {
          const meta = JSON.parse(chapter.meta_json);
          summary = meta.summary ?? null;
        } catch {
          // ignore malformed JSON
        }
      }

      const openedAt = chapter.opened_at.endsWith("Z")
        ? chapter.opened_at
        : chapter.opened_at + "Z";
      const closedAt = chapter.closed_at
        ? (chapter.closed_at.endsWith("Z") ? chapter.closed_at : chapter.closed_at + "Z")
        : null;

      const lines: string[] = ["---"];
      lines.push(`openedAt: "${openedAt}"`);
      if (closedAt) {
        lines.push(`closedAt: "${closedAt}"`);
      }
      if (summary) {
        lines.push(`summary: ${JSON.stringify(summary)}`);
      }
      lines.push("---");
      lines.push("");

      for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i];
        const ts = p.ts.endsWith("Z") ? p.ts : p.ts + "Z";
        const tsPrefix = ts.slice(0, 16);
        lines.push(`[${tsPrefix}] ${p.content}`);
        if (i < paragraphs.length - 1) {
          lines.push("");
        }
      }

      const content = lines.join("\n") + "\n";
      const filename = `${String(chapterNumber).padStart(6, "0")}.md`;
      const filePath = join(arcDir, filename);
      const tmpPath = filePath + ".tmp";
      writeFileSync(tmpPath, content, "utf-8");
      renameSync(tmpPath, filePath);
    }

    console.log(`  Arc "${arc.name}": ${chapters.length} chapters migrated`);
  }

  await db.close();

  console.log(`Done. Migrated ${arcs.length} arcs, ${totalChapters} chapters, ${totalParagraphs} paragraphs.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
