


import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi, afterEach } from "vitest";

import { CONSOLE_LOGGER } from "../src/app/logging.js";
import { ChronicleStore } from "../src/chronicle/chronicle-store.js";
import { ChronicleLifecycleTs } from "../src/chronicle/lifecycle.js";
import { recordUsage } from "../src/cost/cost-span.js";
import { COST_SOURCE, LLM_CALL_TYPE } from "../src/cost/llm-call-type.js";
import { AutoChroniclerTs } from "../src/rooms/autochronicler.js";
import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { buildArc } from "../src/rooms/message.js";
import type { RoomMessage } from "../src/rooms/message.js";
import { createTempHistoryStore } from "./test-helpers.js";

function makeAssistantText(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-completions" as const,
    provider: "openai" as const,
    model: "gpt-4o-mini",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "muaddib-chronicle-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ARC = buildArc("libera", "#test");

describe("ChatHistoryStore", () => {
  it("stores messages and returns chronological context with assistant mode prefix", async () => {
    const store = createTempHistoryStore(10);
    await store.initialize();

    await store.addMessage({
      serverTag: "libera",
      channelName: "#test",
      arc: "libera##test",
      nick: "alice",
      mynick: "muaddib",
      content: "hello",
    });

    await store.addMessage(
      {
        serverTag: "libera",
        channelName: "#test",
      arc: "libera##test",
        nick: "muaddib",
        mynick: "muaddib",
        content: "hi there",
      },
      { mode: "!s" },
    );

    const context = await store.getContext(ARC, 10);

    expect(context).toHaveLength(2);
    expect(context[0].role).toBe("user");
    expect(context[1].role).toBe("assistant");
    const assistantContent = (context[1] as any).content[0].text;
    expect(assistantContent).toContain("!s [");

    await store.close();
  });

  it("updates messages by platform id", async () => {
    const store = createTempHistoryStore(10);
    await store.initialize();

    await store.addMessage({
      serverTag: "libera",
      channelName: "#test",
      arc: "libera##test",
      nick: "alice",
      mynick: "muaddib",
      content: "archive me",
      platformId: "1700000000.1111",
    });

    await store.appendEdit(
      ARC,
      "1700000000.1111",
      "edited",
      "alice",
    );

    // getFullHistory returns raw rows (original + edit)
    const rows = await store.getFullHistory(ARC, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0].message).toBe("<alice> archive me");
    expect(rows[1].message).toBe("<alice> edited");

    // getContext deduplicates by platformId, keeping the edit
    const context = await store.getContext(ARC, 10);
    expect(context).toHaveLength(1);
    const text = (context[0] as any).content;
    expect(text).toContain("edited");

    await store.close();
  });

  it("appendEdit supports assistant role for bot message coalescing", async () => {
    const store = createTempHistoryStore(10);
    await store.initialize();

    const arc = buildArc("slack:test", "general");

    // Bot sends initial response in a thread
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "muaddib",
      mynick: "muaddib",
      content: "bot reply",
      platformId: "5555.0000",
      threadId: "4444.0000",
      responseThreadId: "4444.0000",
    });

    // Cost followup coalesced via edit — appendEdit looks up threadId from the original line
    await store.appendEdit(arc, "5555.0000", "bot reply\n(cost $0.50)", "muaddib", "assistant");

    const context = await store.getContext(arc, 10, "4444.0000");

    // Dedup keeps the edit — one message with combined content
    expect(context).toHaveLength(1);
    expect(context[0].role).toBe("assistant");
    expect((context[0] as any).content[0].text).toContain("bot reply");
    expect((context[0] as any).content[0].text).toContain("cost $0.50");

    await store.close();
  });

  it("thread context shows other thread starters as pre-context with reply counts", async () => {
    const store = createTempHistoryStore(20);
    await store.initialize();

    const arc = buildArc("slack:test", "general");

    // Thread A: user asks about MRs (thread starter + 2 replies)
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc,
      nick: "alice",
      mynick: "muaddib",
      content: "how many MRs?",
      platformId: "1000.0000",
      threadId: "1000.0000",
      responseThreadId: "1000.0000",
    });
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc,
      nick: "muaddib",
      mynick: "muaddib",
      content: "42 MRs",
      platformId: "1001.0000",
      threadId: "1000.0000",
      responseThreadId: "1000.0000",
    });
    // Bot message coalesced via edit — appendEdit looks up threadId from the original line
    await store.appendEdit(arc, "1001.0000", "42 MRs\n(cost $0.21)", "muaddib", "assistant");

    // Thread B: user asks about weather (new top-level message, auto-threaded)
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc,
      nick: "alice",
      mynick: "muaddib",
      content: "what's the weather?",
      platformId: "2000.0000",
      threadId: "2000.0000",
      responseThreadId: "2000.0000",
    });

    // Thread B context: should see Thread A's STARTER as pre-context (with reply annotation),
    // but NOT Thread A's replies or edits.
    const contextB = await store.getContext(arc, 20, "2000.0000");
    const texts = contextB.map((m) =>
      typeof m.content === "string" ? m.content : (m.content as any)[0]?.text ?? "",
    );
    expect(texts.some((t) => t.includes("what's the weather?"))).toBe(true);
    // Thread A starter appears as pre-context with reply annotation
    expect(texts.some((t) => t.includes("how many MRs?"))).toBe(true);
    expect(texts.some((t) => t.includes("<meta>(Thread with"))).toBe(true);
    // Thread A's reply content does NOT appear
    expect(texts.some((t) => t.includes("42 MRs"))).toBe(false);

    await store.close();
  });

  it("appendEdit without threadId leaks into unrelated thread context (pre-fix behavior guard)", async () => {
    // Documents that appendEdit WITHOUT threadId still works for non-threaded edits
    const store = createTempHistoryStore(20);
    await store.initialize();

    const arc = buildArc("slack:test", "general");

    // Main channel message (no thread)
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc,
      nick: "alice",
      mynick: "muaddib",
      content: "original msg",
      platformId: "500.0000",
    });
    await store.appendEdit(arc, "500.0000", "edited msg", "alice");

    // Main context should show the edit
    const mainContext = await store.getContext(arc, 20);
    const mainTexts = mainContext.map((m) =>
      typeof m.content === "string" ? m.content : (m.content as any)[0]?.text ?? "",
    );
    expect(mainTexts.some((t) => t.includes("edited msg"))).toBe(true);
    // Original is deduped away
    expect(mainTexts.filter((t) => t.includes("original msg")).length).toBe(0);

    await store.close();
  });

  it("persists trusted=false and wraps untrusted messages in context", async () => {
    const store = createTempHistoryStore(10);
    await store.initialize();

    await store.addMessage({
      serverTag: "libera",
      channelName: "#test",
      arc: "libera##test",
      nick: "untrusted_user",
      mynick: "muaddib",
      content: "sneaky command",
      trusted: false,
    });

    await store.addMessage({
      serverTag: "libera",
      channelName: "#test",
      arc: "libera##test",
      nick: "trusted_user",
      mynick: "muaddib",
      content: "normal message",
      trusted: true,
    });

    const context = await store.getContext(ARC, 10);
    expect(context).toHaveLength(2);

    // Untrusted message is wrapped
    const untrustedText = (context[0] as any).content;
    expect(untrustedText).toContain("[UNTRUSTED]");
    expect(untrustedText).toContain("<untrusted_user> sneaky command");
    expect(untrustedText).toContain("[/UNTRUSTED]");

    // Trusted message is not wrapped
    const trustedText = (context[1] as any).content;
    expect(trustedText).not.toContain("[UNTRUSTED]");
    expect(trustedText).toContain("<trusted_user> normal message");

    await store.close();
  });

  it("does not wrap messages with undefined trusted status", async () => {
    const store = createTempHistoryStore(10);
    await store.initialize();

    await store.addMessage({
      serverTag: "libera",
      channelName: "#test",
      arc: "libera##test",
      nick: "alice",
      mynick: "muaddib",
      content: "no allowlist configured",
    });

    const context = await store.getContext(ARC, 10);
    expect(context).toHaveLength(1);
    const text = (context[0] as any).content;
    expect(text).not.toContain("[UNTRUSTED]");
    expect(text).toContain("<alice> no allowlist configured");

    await store.close();
  });

  // ── Issue #1: PID dedupe collision ──

  it("does not dedupe user and assistant messages that share the same platformId", async () => {
    const store = createTempHistoryStore(10);
    await store.initialize();

    // Simulate: user sends message, then deliverResult clones it for assistant
    // Both end up with the same platformId — assistant must NOT shadow user.
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "alice",
      mynick: "muaddib",
      content: "what is the spice?",
      platformId: "1234.5678",
    });

    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "muaddib",
      mynick: "muaddib",
      content: "the spice is life",
      platformId: "1234.5678",
    });

    const arc = buildArc("slack:test", "general");
    const context = await store.getContext(arc, 10);

    expect(context).toHaveLength(2);
    expect(context[0].role).toBe("user");
    expect(context[1].role).toBe("assistant");
  });

  it("preserves all messages in a thread when user+assistant share platformId", async () => {
    const store = createTempHistoryStore(10);
    await store.initialize();

    const arc = buildArc("slack:test", "general");

    // Root mention (Slack: pid === tid for root)
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "alice",
      mynick: "muaddib",
      content: "hello",
      platformId: "1000.0000",
      threadId: "1000.0000",
      responseThreadId: "1000.0000",
    });
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "muaddib",
      mynick: "muaddib",
      content: "hi there",
      platformId: "1000.0000",
      threadId: "1000.0000",
      responseThreadId: "1000.0000",
    });

    // Thread reply
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "alice",
      mynick: "muaddib",
      content: "follow up",
      platformId: "2000.0000",
      threadId: "1000.0000",
      responseThreadId: "1000.0000",
    });
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "muaddib",
      mynick: "muaddib",
      content: "follow up answer",
      platformId: "2000.0000",
      threadId: "1000.0000",
      responseThreadId: "1000.0000",
    });

    const context = await store.getContext(arc, 10, "1000.0000");

    // All four messages must be present
    expect(context).toHaveLength(4);
    expect(context[0].role).toBe("user");
    expect(context[1].role).toBe("assistant");
    expect(context[2].role).toBe("user");
    expect(context[3].role).toBe("assistant");
  });

  // ── Issue #2: Thread starter detection ──

  it("finds Slack thread starter when tid === pid (B2 relaxed condition)", async () => {
    const store = createTempHistoryStore(10);
    await store.initialize();

    const arc = buildArc("slack:test", "general");

    // Pre-thread main channel context
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "bob",
      mynick: "muaddib",
      content: "earlier channel message",
    });

    // Slack root mention: pid === tid (auto-thread)
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "alice",
      mynick: "muaddib",
      content: "question in channel",
      platformId: "1000.0000",
      threadId: "1000.0000",
      responseThreadId: "1000.0000",
    });

    // Thread reply
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "alice",
      mynick: "muaddib",
      content: "thread followup",
      platformId: "2000.0000",
      threadId: "1000.0000",
      responseThreadId: "1000.0000",
    });

    const context = await store.getContext(arc, 10, "1000.0000");

    // Should include: pre-thread msg, starter, thread reply = 3
    expect(context).toHaveLength(3);
    expect(context[0].role).toBe("user");
    expect((context[0] as any).content).toContain("earlier channel message");
    expect((context[1] as any).content).toContain("question in channel");
    expect((context[2] as any).content).toContain("thread followup");
  });

  it("finds bot-rooted thread starter via persisted outbound platformId", async () => {
    const store = createTempHistoryStore(10);
    await store.initialize();

    const arc = buildArc("slack:test", "general");

    // Pre-thread context
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "alice",
      mynick: "muaddib",
      content: "earlier context",
    });

    // Bot sends a message to channel (replyStartThread=false),
    // its outbound platformId "5555.0000" is persisted after send.
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "muaddib",
      mynick: "muaddib",
      content: "bot channel message",
      platformId: "5555.0000",
    });

    // User replies in thread on bot's message
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "alice",
      mynick: "muaddib",
      content: "replying to bot",
      platformId: "7777.0000",
      threadId: "5555.0000",
      responseThreadId: "5555.0000",
    });

    const context = await store.getContext(arc, 10, "5555.0000");

    // Should include: pre-thread msg, bot starter, thread reply = 3
    expect(context).toHaveLength(3);
    expect((context[0] as any).content).toContain("earlier context");
    // Bot starter is an assistant message — content is [{type:"text", text:"..."}]
    expect(context[1].role).toBe("assistant");
    expect((context[1] as any).content[0].text).toContain("bot channel message");
    expect((context[2] as any).content).toContain("replying to bot");
  });

  it("finds thread starter beyond a naive line-count window", async () => {
    // With inferenceLimit=3, a naive maxLines=30 would miss the starter.
    // The until-predicate approach reads files until the starter is found.
    const store = createTempHistoryStore(3);
    await store.initialize();

    const arc = buildArc("slack:test", "general");

    // Thread starter
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "alice",
      mynick: "muaddib",
      content: "thread root",
      platformId: "1000.0000",
      threadId: "1000.0000",
      responseThreadId: "1000.0000",
    });

    // 35 unrelated main-channel messages to push the starter far back
    for (let i = 0; i < 35; i++) {
      await store.addMessage({
        serverTag: "slack:test",
        channelName: "general",
      arc: "slack:test#general",
        nick: "bob",
        mynick: "muaddib",
        content: `filler ${i}`,
      });
    }

    // Thread reply (recent)
    await store.addMessage({
      serverTag: "slack:test",
      channelName: "general",
      arc: "slack:test#general",
      nick: "alice",
      mynick: "muaddib",
      content: "thread reply",
      platformId: "9000.0000",
      threadId: "1000.0000",
      responseThreadId: "1000.0000",
    });

    const context = await store.getContext(arc, 3, "1000.0000");

    const texts = context.map((m) =>
      typeof m.content === "string" ? m.content : (m.content as any)[0]?.text ?? "",
    );
    expect(texts.some((t) => t.includes("thread root"))).toBe(true);
    expect(texts.some((t) => t.includes("thread reply"))).toBe(true);
  });

  it("countMessagesSince counts messages from yesterday when crossing midnight", async () => {
    const store = createTempHistoryStore(10);
    await store.initialize();

    // Directly write a JSONL file dated yesterday to simulate messages
    // written before midnight (the proactive debounce use case).
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const arc = ARC;
    const histDir = join((store as any).arcsBasePath, arc, "chat_history");
    mkdirSync(histDir, { recursive: true });
    const yesterdayTs = `${yesterday}T23:59:00.000Z`;
    appendFileSync(
      join(histDir, `${yesterday}.jsonl`),
      JSON.stringify({ ts: yesterdayTs, n: "alice", r: "user", m: "late night msg" }) + "\n",
      "utf-8",
    );

    // sinceEpochMs is 5 minutes before the message — crosses into yesterday
    const sinceMs = new Date(yesterdayTs).getTime() - 5 * 60 * 1000;
    const count = await store.countMessagesSince(arc, sinceMs);

    expect(count).toBe(1);

    await store.close();
  });

  it("selfRun sets run field to the line's own timestamp", async () => {
    const dir = makeTempDir();
    const store = new ChatHistoryStore(dir);
    await store.initialize();

    const ts = await store.addMessage(
      { serverTag: "libera", channelName: "#test",
      arc: "libera##test", nick: "alice", mynick: "muaddib", content: "trigger" },
      { selfRun: true },
    );

    // Read raw JSONL to verify the run field
    const jsonlPath = join(dir, ARC, "chat_history", `${ts.slice(0, 10)}.jsonl`);
    const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].run).toBe(ts);
    expect(lines[0].ts).toBe(ts);

    await store.close();
  });

  it("counts and marks chronicled messages", async () => {
    const store = createTempHistoryStore(10);
    await store.initialize();

    const ts = await store.addMessage({
      serverTag: "libera",
      channelName: "#test",
      arc: "libera##test",
      nick: "alice",
      mynick: "muaddib",
      content: "archive me",
    });

    expect(await store.countRecentUnchronicled(ARC, 7)).toBe(1);

    store.markChronicled(ARC, ts);

    expect(await store.countRecentUnchronicled(ARC, 7)).toBe(0);

    await store.close();
  });

});

describe("ChronicleStore", () => {
  it("opens chapter, appends paragraph, and returns context messages", async () => {
    const dir = makeTempDir();
    const store = new ChronicleStore(dir);
    await store.initialize();

    const chapter = await store.getOrOpenCurrentChapter("libera##test");
    expect(chapter.number).toBeGreaterThan(0);

    await store.appendParagraph("libera##test", "Important update");

    const contextMessages = await store.getChapterContextMessages("libera##test");
    expect(contextMessages.some((message) =>
      message.role === "user" && typeof message.content === "string" && message.content.includes("Important update"),
    )).toBe(true);

    await store.close();
  });

  it("rolls chapters at threshold and inserts recap paragraph via lifecycle automation", async () => {
    const dir = makeTempDir();
    const chronicleStore = new ChronicleStore(dir);
    await chronicleStore.initialize();

    const modelAdapter = {
      completeSimple: vi.fn(async () => makeAssistantText("Chapter summary paragraph.")),
    } as any;

    const lifecycle = new ChronicleLifecycleTs({
      chronicleStore,
      config: {
        model: "openai:gpt-4o-mini",
        paragraphsPerChapter: 2,
      },
      modelAdapter,
      logger: CONSOLE_LOGGER,
    });

    await lifecycle.appendParagraph("libera##test", "First operational note.");
    const chapterBefore = await chronicleStore.getOrOpenCurrentChapter("libera##test");

    await lifecycle.appendParagraph("libera##test", "Second operational note.");
    const chapterAfter = await chronicleStore.getOrOpenCurrentChapter("libera##test");

    expect(chapterAfter.number).toBeGreaterThan(chapterBefore.number);
    expect(modelAdapter.completeSimple).toHaveBeenCalledTimes(1);

    const currentParagraphs = await chronicleStore.readChapter(chapterAfter.number, "libera##test");
    expect(currentParagraphs.some((p) => p.includes("Previous chapter recap: Chapter summary paragraph."))).toBe(true);
    expect(currentParagraphs.some((p) => p.includes("Second operational note."))).toBe(true);

    await chronicleStore.close();
  });

  it("parses chapter files with space-separated timestamps (migrated data)", async () => {
    const dir = makeTempDir();
    const store = new ChronicleStore(dir);
    await store.initialize();

    // Write a file matching migration script format (space between date and time)
    const arcDir = join(dir, "libera##test", "chronicle");
    mkdirSync(arcDir, { recursive: true });
    writeFileSync(join(arcDir, "000001.md"), [
      "---",
      'openedAt: "2026-02-23 23:55:46Z"',
      "---",
      "",
      "[2026-02-23 23:55] Previous chapter recap: some summary",
      "",
      "[2026-02-24 00:46] Second paragraph content",
      "",
    ].join("\n"));

    const contextMessages = await store.getChapterContextMessages("libera##test");
    expect(contextMessages).toHaveLength(2);
    expect(contextMessages[0].content).toContain("Previous chapter recap: some summary");
    expect(contextMessages[1].content).toContain("Second paragraph content");

    await store.close();
  });

});

describe("AutoChroniclerTs", () => {
  it("returns false without chronicling when unchronicled message count is below threshold", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    await history.addMessage({
      serverTag: "libera",
      channelName: "#test",
      arc: "libera##test",
      nick: "alice",
      mynick: "muaddib",
      content: "only one",
    });

    const dir = makeTempDir();
    const chronicleStore = new ChronicleStore(dir);
    await chronicleStore.initialize();

    const lifecycle = new ChronicleLifecycleTs({
      chronicleStore,
      config: {
        model: "openai:gpt-4o-mini",
      },
      modelAdapter: { completeSimple: vi.fn(async () => makeAssistantText("summary")) } as any,
      logger: CONSOLE_LOGGER,
    });

    const modelAdapter = { completeSimple: vi.fn(async () => makeAssistantText("should not be called")) } as any;

    const autoChronicler = new AutoChroniclerTs({
      history,
      chronicleStore,
      lifecycle,
      config: {
        model: "openai:gpt-4o-mini",
      },
      modelAdapter,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    const triggered = await autoChronicler.checkAndChronicle("muaddib", "libera", "#test", 2);

    expect(triggered).toBe(false);
    expect(modelAdapter.completeSimple).not.toHaveBeenCalled();

    await history.close();
    await chronicleStore.close();
  }, 10000);

  it("triggers chronicling at threshold, appends chronicle paragraph, and marks messages chronicled", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    await history.addMessage({
      serverTag: "libera",
      channelName: "#test",
      arc: "libera##test",
      nick: "alice",
      mynick: "muaddib",
      content: "one",
    });
    await history.addMessage({
      serverTag: "libera",
      channelName: "#test",
      arc: "libera##test",
      nick: "bob",
      mynick: "muaddib",
      content: "two",
    });

    const dir = makeTempDir();
    const chronicleStore = new ChronicleStore(dir);
    await chronicleStore.initialize();

    const lifecycle = new ChronicleLifecycleTs({
      chronicleStore,
      config: {
        model: "openai:gpt-4o-mini",
        paragraphsPerChapter: 5,
      },
      modelAdapter: {
        completeSimple: vi.fn(async () => makeAssistantText("Chapter summary paragraph.")),
      } as any,
      logger: CONSOLE_LOGGER,
    });

    const modelAdapter = {
      completeSimple: vi.fn(async () => {
        recordUsage(LLM_CALL_TYPE.AUTOCHRONICLER_APPEND, "openai:gpt-4o-mini", {
          input: 6,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 9,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.04 },
        });
        return makeAssistantText("Auto chronicled paragraph.");
      }),
    } as any;

    const autoChronicler = new AutoChroniclerTs({
      history,
      chronicleStore,
      lifecycle,
      config: {
        model: "openai:gpt-4o-mini",
      },
      modelAdapter,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    const triggered = await autoChronicler.checkAndChronicle("muaddib", "libera", "#test", 2);

    expect(triggered).toBe(true);
    expect(modelAdapter.completeSimple).toHaveBeenCalledTimes(1);
    expect(await history.countRecentUnchronicled(ARC, 7)).toBe(0);

    const currentChapter = await chronicleStore.getOrOpenCurrentChapter("libera##test");
    const paragraphs = await chronicleStore.readChapter(currentChapter.number, "libera##test");
    expect(paragraphs.some((p) => p.includes("Auto chronicled paragraph."))).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const historyFile = join((history as any).arcsBasePath, "libera##test", "chat_history", `${today}.jsonl`);
    const historyRows = readFileSync(historyFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    const costRows = historyRows.filter((row) => row.call);
    expect(costRows).toHaveLength(1);
    expect(costRows[0]).toMatchObject({
      call: LLM_CALL_TYPE.AUTOCHRONICLER_APPEND,
      source: COST_SOURCE.AUTOCHRONICLER,
      model: "openai:gpt-4o-mini",
      cost: 0.04,
    });

    await history.close();
    await chronicleStore.close();
  });
});

// ── In-flight trigger annotation ──

function roomMsg(nick: string, content: string, mynick = "Bot"): RoomMessage {
  return {
    serverTag: "test",
    channelName: "#test",
    arc: "test###test",
    nick,
    mynick,
    content,
  };
}

/** Tiny delay to ensure unique `new Date().toISOString()` timestamps between addMessage calls. */
const tick = () => new Promise<void>((r) => setTimeout(r, 2));

describe("ChatHistoryStore – in-flight trigger annotation", () => {
  it("annotates in-flight trigger messages", async () => {
    const store = createTempHistoryStore();
    await store.initialize();

    await store.addMessage(roomMsg("fenn", "hello bot"), { selfRun: true });
    await tick();
    await store.addMessage(roomMsg("mlu", "hey bot"), { selfRun: true });

    const context = await store.getContext("test###test");

    const fennMsg = context.find((m) => typeof m.content === "string" && m.content.includes("fenn"));
    expect(fennMsg).toBeDefined();
    expect(fennMsg!.content).toContain("<meta>(My response to this message is already in progress.)</meta>");

    const mluMsg = context.find((m) => typeof m.content === "string" && m.content.includes("mlu"));
    expect(mluMsg).toBeDefined();
    expect(mluMsg!.content).toContain("<meta>(My response to this message is already in progress.)</meta>");
  });

  it("does not annotate triggers that already have a response", async () => {
    const store = createTempHistoryStore();
    await store.initialize();

    const fennTs = await store.addMessage(roomMsg("fenn", "hello bot"), { selfRun: true });
    await tick();
    await store.addMessage(roomMsg("Bot", "hi fenn"), { run: fennTs });
    await tick();
    await store.addMessage(roomMsg("mlu", "hey bot"), { selfRun: true });

    const context = await store.getContext("test###test");

    const fennMsg = context.find((m) => typeof m.content === "string" && m.content.includes("fenn") && !m.content.includes("Bot"));
    expect(fennMsg).toBeDefined();
    expect(fennMsg!.content).not.toContain("<meta>");

    const mluMsg = context.find((m) => typeof m.content === "string" && m.content.includes("mlu"));
    expect(mluMsg).toBeDefined();
    expect(mluMsg!.content).toContain("<meta>");
  });

  it("does not annotate messages that are not self-run triggers", async () => {
    const store = createTempHistoryStore();
    await store.initialize();

    await store.addMessage(roomMsg("fenn", "just chatting"));
    await tick();
    await store.addMessage(roomMsg("mlu", "hey bot"), { selfRun: true });

    const context = await store.getContext("test###test");

    const fennMsg = context.find((m) => typeof m.content === "string" && m.content.includes("fenn"));
    expect(fennMsg).toBeDefined();
    expect(fennMsg!.content).not.toContain("<meta>");
  });

  it("annotates multiple in-flight triggers from different nicks", async () => {
    const store = createTempHistoryStore();
    await store.initialize();

    await store.addMessage(roomMsg("alice", "q1"), { selfRun: true });
    await tick();
    await store.addMessage(roomMsg("bob", "q2"), { selfRun: true });
    await tick();
    await store.addMessage(roomMsg("charlie", "q3"), { selfRun: true });

    const context = await store.getContext("test###test");

    const annotated = context.filter(
      (m) => typeof m.content === "string" && m.content.includes("<meta>"),
    );
    expect(annotated).toHaveLength(3);
  });

  it("handles same nick with multiple in-flight triggers across modes", async () => {
    const store = createTempHistoryStore();
    await store.initialize();

    const ts1 = await store.addMessage(roomMsg("fenn", "!s deep question"), { selfRun: true });
    await tick();
    await store.addMessage(roomMsg("fenn", "!q quick question"), { selfRun: true });
    await tick();
    await store.addMessage(roomMsg("Bot", "deep answer"), { run: ts1 });

    const context = await store.getContext("test###test");

    const deepMsg = context.find((m) => typeof m.content === "string" && m.content.includes("deep question"));
    expect(deepMsg).toBeDefined();
    expect(deepMsg!.content).not.toContain("<meta>");

    const quickMsg = context.find((m) => typeof m.content === "string" && m.content.includes("quick question"));
    expect(quickMsg).toBeDefined();
    expect(quickMsg!.content).toContain("<meta>");
  });

  it("excludes current trigger from annotation via excludeRunTs", async () => {
    const store = createTempHistoryStore();
    await store.initialize();

    await store.addMessage(roomMsg("alice", "first question"), { selfRun: true });
    await tick();
    const ts2 = await store.addMessage(roomMsg("bob", "second question"), { selfRun: true });

    // Without exclusion: both annotated
    const ctxAll = await store.getContext("test###test");
    const allAnnotated = ctxAll.filter(
      (m) => typeof m.content === "string" && m.content.includes("<meta>"),
    );
    expect(allAnnotated).toHaveLength(2);

    // With exclusion: only alice annotated, bob (the current trigger) is not
    const ctxExcluded = await store.getContext("test###test", undefined, undefined, {
      excludeRunTs: ts2,
    });
    const aliceMsg = ctxExcluded.find(
      (m) => typeof m.content === "string" && m.content.includes("alice"),
    );
    expect(aliceMsg!.content).toContain("<meta>");

    const bobMsg = ctxExcluded.find(
      (m) => typeof m.content === "string" && m.content.includes("bob"),
    );
    expect(bobMsg!.content).not.toContain("<meta>");
  });
});
