

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi, afterEach } from "vitest";

import { CONSOLE_LOGGER } from "../src/app/logging.js";
import { ChronicleStore } from "../src/chronicle/chronicle-store.js";
import { ChronicleLifecycleTs } from "../src/chronicle/lifecycle.js";
import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { AutoChroniclerTs } from "../src/rooms/autochronicler.js";

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

describe("ChatHistoryStore", () => {
  it("stores messages and returns chronological context with assistant mode prefix", async () => {
    const store = new ChatHistoryStore(":memory:", 10);
    await store.initialize();

    await store.addMessage({
      serverTag: "libera",
      channelName: "#test",
      nick: "alice",
      mynick: "muaddib",
      content: "hello",
    });

    await store.addMessage(
      {
        serverTag: "libera",
        channelName: "#test",
        nick: "muaddib",
        mynick: "muaddib",
        content: "hi there",
      },
      { mode: "!s" },
    );

    const context = await store.getContext("libera", "#test", 10);

    expect(context).toHaveLength(2);
    expect(context[0].role).toBe("user");
    expect(context[1].role).toBe("assistant");
    const assistantContent = (context[1] as any).content[0].text;
    expect(assistantContent).toContain("!s [");

    await store.close();
  });

  it("updates and resolves messages by platform id", async () => {
    const store = new ChatHistoryStore(":memory:", 10);
    await store.initialize();

    const messageId = await store.addMessage({
      serverTag: "libera",
      channelName: "#test",
      nick: "alice",
      mynick: "muaddib",
      content: "archive me",
      platformId: "1700000000.1111",
    });

    expect(await store.getMessageIdByPlatformId("libera", "#test", "1700000000.1111")).toBe(
      messageId,
    );

    await store.updateMessageByPlatformId(
      "libera",
      "#test",
      "1700000000.1111",
      "edited",
      "alice",
    );

    const rows = await store.getFullHistory("libera", "#test", 10);
    expect(rows[0].message).toBe("<alice> edited");

    await store.close();
  });

  it("returns recent followup messages since timestamp with thread-aware filtering", async () => {
    const store = new ChatHistoryStore(":memory:", 10);
    await store.initialize();

    await store.addMessage({
      serverTag: "libera",
      channelName: "#test",
      nick: "alice",
      mynick: "muaddib",
      content: "main followup",
    });
    await store.addMessage({
      serverTag: "libera",
      channelName: "#test",
      nick: "alice",
      mynick: "muaddib",
      content: "thread followup",
      threadId: "thread-1",
    });
    await store.addMessage({
      serverTag: "libera",
      channelName: "#test",
      nick: "alice",
      mynick: "muaddib",
      content: "other thread followup",
      threadId: "thread-2",
    });
    await store.addMessage({
      serverTag: "libera",
      channelName: "#test",
      nick: "bob",
      mynick: "muaddib",
      content: "bob followup",
      threadId: "thread-1",
    });

    const mainFollowups = await store.getRecentMessagesSince("libera", "#test", "alice", 0);
    expect(mainFollowups).toEqual([
      {
        message: "main followup",
        timestamp: expect.any(String),
      },
    ]);

    const threadFollowups = await store.getRecentMessagesSince(
      "libera",
      "#test",
      "alice",
      0,
      "thread-1",
    );
    expect(threadFollowups).toEqual([
      {
        message: "thread followup",
        timestamp: expect.any(String),
      },
    ]);

    await store.close();
  });

  it("counts and marks chronicled messages", async () => {
    const store = new ChatHistoryStore(":memory:", 10);
    await store.initialize();

    const messageId = await store.addMessage({
      serverTag: "libera",
      channelName: "#test",
      nick: "alice",
      mynick: "muaddib",
      content: "archive me",
    });

    expect(await store.countRecentUnchronicled("libera", "#test", 7)).toBe(1);

    await store.markChronicled([messageId], 123);

    expect(await store.countRecentUnchronicled("libera", "#test", 7)).toBe(0);

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
    const arcDir = join(dir, "libera##test");
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

  it("readAllChapterFiles returns all chapter files for gondolin mounting", async () => {
    const dir = makeTempDir();
    const store = new ChronicleStore(dir);
    await store.initialize();

    await store.getOrOpenCurrentChapter("libera##test");
    await store.appendParagraph("libera##test", "Some content");

    const files = store.readAllChapterFiles("libera##test");
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].filename).toMatch(/^\d{6}\.md$/);
    expect(files[0].content).toContain("Some content");
  });
});

describe("AutoChroniclerTs", () => {
  it("returns false without chronicling when unchronicled message count is below threshold", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    await history.addMessage({
      serverTag: "libera",
      channelName: "#test",
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
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    await history.addMessage({
      serverTag: "libera",
      channelName: "#test",
      nick: "alice",
      mynick: "muaddib",
      content: "one",
    });
    await history.addMessage({
      serverTag: "libera",
      channelName: "#test",
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

    const modelAdapter = { completeSimple: vi.fn(async () => makeAssistantText("Auto chronicled paragraph.")) } as any;

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
    expect(await history.countRecentUnchronicled("libera", "#test", 7)).toBe(0);

    const currentChapter = await chronicleStore.getOrOpenCurrentChapter("libera##test");
    const paragraphs = await chronicleStore.readChapter(currentChapter.number, "libera##test");
    expect(paragraphs.some((p) => p.includes("Auto chronicled paragraph."))).toBe(true);

    await history.close();
    await chronicleStore.close();
  });
});
