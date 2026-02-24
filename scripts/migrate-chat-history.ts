#!/usr/bin/env npx tsx
/**
 * Migrate chat history from SQLite (chat_history.db) to per-arc JSONL files,
 * and relocate chronicle/workspace/checkpoint directories under arcs/.
 *
 * Usage:
 *   npx tsx scripts/migrate-chat-history.ts [--db path] [--home path]
 *
 * Defaults:
 *   --db   $MUADDIB_HOME/chat_history.db
 *   --home $MUADDIB_HOME
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

/** Matches fsSafeArc() from src/rooms/message.ts */
function fsSafeArc(raw: string): string {
  return raw.replaceAll("%", "%25").replaceAll("/", "%2F");
}

/** Convert SQLite timestamp "YYYY-MM-DD HH:MM:SS" → ISO 8601 "YYYY-MM-DDTHH:MM:SSZ" */
function toIso(ts: string | null): string | null {
  if (!ts) return null;
  let iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  if (!iso.endsWith("Z")) iso += "Z";
  // Ensure milliseconds for consistency
  if (/T\d{2}:\d{2}:\d{2}Z$/.test(iso)) {
    iso = iso.replace("Z", ".000Z");
  }
  return iso;
}

interface ChatRow {
  id: number;
  server_tag: string;
  channel_name: string;
  nick: string;
  message: string;
  role: string;
  timestamp: string;
  chapter_id: number | null;
  mode: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

interface LlmCallRow {
  id: number;
  timestamp: string;
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

interface JsonlLine {
  ts: string;
  n?: string;
  r?: string;
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
}

async function main() {
  const args = process.argv.slice(2);
  const muaddibHome = process.env.MUADDIB_HOME
    ? resolve(process.env.MUADDIB_HOME)
    : join(homedir(), ".muaddib");

  let dbPath = join(muaddibHome, "chat_history.db");
  let homePath = muaddibHome;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && args[i + 1]) {
      dbPath = resolve(args[++i]);
    } else if (args[i] === "--home" && args[i + 1]) {
      homePath = resolve(args[++i]);
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      console.error("Usage: npx tsx scripts/migrate-chat-history.ts [--db path] [--home path]");
      process.exit(1);
    }
  }

  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  const arcsBase = join(homePath, "arcs");
  console.log(`Migrating: ${dbPath} → ${arcsBase}`);

  const { open } = await import("sqlite");
  const sqlite3 = (await import("sqlite3")).default;

  const db = await open({ filename: dbPath, driver: sqlite3.Database });

  // ── 1. Build lookup maps ──────────────────────────────────────────────────

  // All messages indexed by id
  const allMessages = await db.all<ChatRow[]>(
    "SELECT id, server_tag, channel_name, nick, message, role, timestamp, chapter_id, mode, platform_id, thread_id FROM chat_messages ORDER BY timestamp ASC, id ASC",
  );
  const messageById = new Map<number, ChatRow>();
  for (const msg of allMessages) {
    messageById.set(msg.id, msg);
  }

  // All llm_calls
  const allCalls = await db.all<LlmCallRow[]>(
    "SELECT id, timestamp, provider, model, input_tokens, output_tokens, cost, call_type, arc_name, trigger_message_id, response_message_id FROM llm_calls ORDER BY id ASC",
  );

  // Index llm_calls by response_message_id for joining to assistant messages
  const callByResponseId = new Map<number, LlmCallRow>();
  for (const call of allCalls) {
    if (call.response_message_id != null) {
      callByResponseId.set(call.response_message_id, call);
    }
  }

  // ── 2. Distinct arcs ─────────────────────────────────────────────────────

  const arcPairs = await db.all<Array<{ server_tag: string; channel_name: string }>>(
    "SELECT DISTINCT server_tag, channel_name FROM chat_messages ORDER BY server_tag, channel_name",
  );

  let totalMessages = 0;
  let totalFiles = 0;

  // Track which llm_calls were written inline with their response message
  const inlinedCallIds = new Set<number>();

  for (const pair of arcPairs) {
    const arc = fsSafeArc(`${pair.server_tag}#${pair.channel_name}`);
    const histDir = join(arcsBase, arc, "chat_history");

    // Get messages for this arc
    const messages = allMessages.filter(
      (m) => m.server_tag === pair.server_tag && m.channel_name === pair.channel_name,
    );

    if (messages.length === 0) continue;

    // Group by date
    const byDate = new Map<string, ChatRow[]>();
    for (const msg of messages) {
      const iso = toIso(msg.timestamp)!;
      const date = iso.slice(0, 10);
      let group = byDate.get(date);
      if (!group) {
        group = [];
        byDate.set(date, group);
      }
      group.push(msg);
    }

    let arcCount = 0;

    for (const [date, dayMessages] of byDate) {
      const filePath = join(histDir, `${date}.jsonl`);

      // Don't overwrite existing files
      if (existsSync(filePath)) {
        continue;
      }

      mkdirSync(histDir, { recursive: true });

      const lines: string[] = [];

      for (const msg of dayMessages) {
        const ts = toIso(msg.timestamp)!;

        // Strip <nick> prefix from message
        const nickPrefixMatch = msg.message.match(/^<([^>]+)> /);
        const rawText = nickPrefixMatch ? msg.message.slice(nickPrefixMatch[0].length) : msg.message;

        const line: JsonlLine = {
          ts,
          n: msg.nick,
          r: msg.role === "assistant" ? "a" : "u",
          m: rawText,
        };

        if (msg.mode) line.mode = msg.mode;
        if (msg.platform_id) line.pid = msg.platform_id;
        if (msg.thread_id) line.tid = msg.thread_id;

        // Join with llm_calls for assistant messages
        const call = callByResponseId.get(msg.id);
        if (call) {
          inlinedCallIds.add(call.id);

          // Compute run: trigger message's timestamp
          if (call.trigger_message_id != null) {
            const triggerMsg = messageById.get(call.trigger_message_id);
            if (triggerMsg) {
              line.run = toIso(triggerMsg.timestamp)!;
            }
          }

          if (call.call_type) line.call = call.call_type;
          line.model = `${call.provider}:${call.model}`;
          if (call.input_tokens != null) line.inTok = call.input_tokens;
          if (call.output_tokens != null) line.outTok = call.output_tokens;
          if (call.cost != null) line.cost = call.cost;
        } else if (msg.role === "user") {
          // For user messages that trigger responses, run = own timestamp
          // Check if any llm_call references this message as trigger
          const isTriggering = allCalls.some((c) => c.trigger_message_id === msg.id);
          if (isTriggering) {
            line.run = ts;
          }
        }

        lines.push(JSON.stringify(line));
        arcCount++;
      }

      const tmpPath = filePath + ".tmp";
      writeFileSync(tmpPath, lines.join("\n") + "\n", "utf-8");
      renameSync(tmpPath, filePath);
      totalFiles++;
    }

    // ── Standalone LLM calls (not inlined) ──────────────────────────────
    // Calls whose response_message_id is NULL, or whose trigger's arc differs
    const standaloneForArc: LlmCallRow[] = [];
    for (const call of allCalls) {
      if (inlinedCallIds.has(call.id)) continue;

      // Determine if this call belongs to this arc
      let callArc: string | null = null;
      if (call.arc_name) {
        callArc = call.arc_name;
      } else if (call.trigger_message_id != null) {
        const triggerMsg = messageById.get(call.trigger_message_id);
        if (triggerMsg) {
          callArc = fsSafeArc(`${triggerMsg.server_tag}#${triggerMsg.channel_name}`);
        }
      }
      if (callArc === arc) {
        standaloneForArc.push(call);
      }
    }

    // Group standalone calls by date and write them
    const standByDate = new Map<string, LlmCallRow[]>();
    for (const call of standaloneForArc) {
      const ts = toIso(call.timestamp)!;
      const date = ts.slice(0, 10);
      let group = standByDate.get(date);
      if (!group) {
        group = [];
        standByDate.set(date, group);
      }
      group.push(call);
    }

    for (const [date, calls] of standByDate) {
      const filePath = join(histDir, `${date}.jsonl`);
      // For standalone calls, we append to existing files or create new ones
      // But skip if the file already existed before migration (don't overwrite)
      mkdirSync(histDir, { recursive: true });

      const lines: string[] = [];
      for (const call of calls) {
        const ts = toIso(call.timestamp)!;
        const line: JsonlLine = { ts };

        if (call.trigger_message_id != null) {
          const triggerMsg = messageById.get(call.trigger_message_id);
          if (triggerMsg) {
            line.run = toIso(triggerMsg.timestamp)!;
          }
        }
        if (call.call_type) line.call = call.call_type;
        line.model = `${call.provider}:${call.model}`;
        if (call.input_tokens != null) line.inTok = call.input_tokens;
        if (call.output_tokens != null) line.outTok = call.output_tokens;
        if (call.cost != null) line.cost = call.cost;

        lines.push(JSON.stringify(line));
        arcCount++;
      }

      if (lines.length > 0) {
        // If the file already exists (written above for messages), append
        if (existsSync(filePath)) {
          appendFileSync(filePath, lines.join("\n") + "\n", "utf-8");
        } else {
          const tmpPath = filePath + ".tmp";
          writeFileSync(tmpPath, lines.join("\n") + "\n", "utf-8");
          renameSync(tmpPath, filePath);
          totalFiles++;
        }
      }
    }

    // ── Chronicle cursor ────────────────────────────────────────────────
    // Max timestamp of messages where chapter_id IS NOT NULL
    const maxChronicled = messages
      .filter((m) => m.chapter_id != null)
      .map((m) => toIso(m.timestamp)!)
      .sort()
      .pop();

    if (maxChronicled) {
      const cursorDir = join(arcsBase, arc, "chronicle");
      const cursorPath = join(cursorDir, "cursor.json");
      if (!existsSync(cursorPath)) {
        mkdirSync(cursorDir, { recursive: true });
        const tmpPath = cursorPath + ".tmp";
        writeFileSync(tmpPath, JSON.stringify({ ts: maxChronicled }) + "\n", "utf-8");
        renameSync(tmpPath, cursorPath);
      }
    }

    totalMessages += arcCount;
    console.log(`  Arc "${arc}": ${arcCount} lines migrated`);
  }

  await db.close();

  // ── 4. Relocate existing directories ──────────────────────────────────

  // Collect all arc names we know about (from migration + existing dirs)
  const knownArcs = new Set(arcPairs.map((p) => fsSafeArc(`${p.server_tag}#${p.channel_name}`)));

  // Also scan chronicle/, workspaces/, checkpoints/ for arc names
  const chronicleDir = join(homePath, "chronicle");
  if (existsSync(chronicleDir)) {
    try {
      for (const name of readdirSync(chronicleDir)) {
        knownArcs.add(name);
      }
    } catch {
      // ignore
    }
  }

  const workspacesDir = join(homePath, "workspaces");
  if (existsSync(workspacesDir)) {
    try {
      for (const name of readdirSync(workspacesDir)) {
        knownArcs.add(name);
      }
    } catch {
      // ignore
    }
  }

  const checkpointsDir = join(homePath, "checkpoints");
  if (existsSync(checkpointsDir)) {
    try {
      for (const name of readdirSync(checkpointsDir)) {
        if (name.endsWith(".qcow2")) {
          knownArcs.add(name.replace(/\.qcow2$/, ""));
        }
      }
    } catch {
      // ignore
    }
  }

  let relocated = 0;

  for (const arc of knownArcs) {
    // chronicle/<arc>/ → arcs/<arc>/chronicle/
    const srcChronicle = join(homePath, "chronicle", arc);
    const dstChronicle = join(arcsBase, arc, "chronicle");
    if (existsSync(srcChronicle) && !existsSync(dstChronicle)) {
      mkdirSync(join(arcsBase, arc), { recursive: true });
      renameSync(srcChronicle, dstChronicle);
      console.log(`  Moved chronicle/${arc}/ → arcs/${arc}/chronicle/`);
      relocated++;
    }

    // workspaces/<arc>/ → arcs/<arc>/workspace/ (singular)
    const srcWorkspace = join(homePath, "workspaces", arc);
    const dstWorkspace = join(arcsBase, arc, "workspace");
    if (existsSync(srcWorkspace) && !existsSync(dstWorkspace)) {
      mkdirSync(join(arcsBase, arc), { recursive: true });
      renameSync(srcWorkspace, dstWorkspace);
      console.log(`  Moved workspaces/${arc}/ → arcs/${arc}/workspace/`);
      relocated++;
    }

    // checkpoints/<arc>.qcow2 → arcs/<arc>/checkpoint.qcow2
    const srcCheckpoint = join(homePath, "checkpoints", `${arc}.qcow2`);
    const dstCheckpoint = join(arcsBase, arc, "checkpoint.qcow2");
    if (existsSync(srcCheckpoint) && !existsSync(dstCheckpoint)) {
      mkdirSync(join(arcsBase, arc), { recursive: true });
      renameSync(srcCheckpoint, dstCheckpoint);
      console.log(`  Moved checkpoints/${arc}.qcow2 → arcs/${arc}/checkpoint.qcow2`);
      relocated++;
    }
  }

  console.log(`Done. Migrated ${arcPairs.length} arcs, ${totalMessages} lines, ${totalFiles} files. Relocated ${relocated} directories.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
