import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
    expect(context[1].content).toContain("!s [");

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
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs.splice(0, createdDirs.length)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("opens chapter, appends paragraph, and returns context messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-chronicle-"));
    createdDirs.push(dir);
    const dbPath = join(dir, "chronicle.db");

    const store = new ChronicleStore(dbPath);
    await store.initialize();

    const chapter = await store.getOrOpenCurrentChapter("libera##test");
    expect(chapter.id).toBeGreaterThan(0);

    await store.appendParagraph("libera##test", "Important update");

    const contextMessages = await store.getChapterContextMessages("libera##test");
    expect(contextMessages.some((message) => message.content.includes("Important update"))).toBe(
      true,
    );

    const rendered = await store.renderChapter("libera##test");
    expect(rendered).toContain("Arc: libera##test");
    expect(rendered).toContain("Important update");

    const relativeRendered = await store.renderChapterRelative("libera##test", 0);
    expect(relativeRendered).toContain("current");
    expect(relativeRendered).toContain("Important update");

    await store.close();
  });

  it("rolls chapters at threshold and inserts recap paragraph via lifecycle automation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-chronicle-"));
    createdDirs.push(dir);

    const chronicleStore = new ChronicleStore(join(dir, "chronicle.db"));
    await chronicleStore.initialize();

    const completeFn = vi.fn(async () => makeAssistantText("Chapter summary paragraph."));

    const lifecycle = new ChronicleLifecycleTs({
      chronicleStore,
      config: {
        model: "openai:gpt-4o-mini",
        paragraphs_per_chapter: 2,
      },
      completeFn,
    });

    await lifecycle.appendParagraph("libera##test", "First operational note.");
    const chapterBefore = await chronicleStore.getOrOpenCurrentChapter("libera##test");

    await lifecycle.appendParagraph("libera##test", "Second operational note.");
    const chapterAfter = await chronicleStore.getOrOpenCurrentChapter("libera##test");

    expect(chapterAfter.id).toBeGreaterThan(chapterBefore.id);
    expect(completeFn).toHaveBeenCalledTimes(1);

    const currentChapter = await chronicleStore.renderChapterRelative("libera##test", 0);
    expect(currentChapter).toContain("Previous chapter recap: Chapter summary paragraph.");
    expect(currentChapter).toContain("Second operational note.");

    const previousChapter = await chronicleStore.renderChapterRelative("libera##test", -1);
    expect(previousChapter).toContain("First operational note.");

    await chronicleStore.close();
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

    const dir = await mkdtemp(join(tmpdir(), "muaddib-chronicle-"));
    const chronicleStore = new ChronicleStore(join(dir, "chronicle.db"));
    await chronicleStore.initialize();

    const lifecycle = new ChronicleLifecycleTs({
      chronicleStore,
      config: {
        model: "openai:gpt-4o-mini",
      },
      completeFn: vi.fn(async () => makeAssistantText("summary")),
    });

    const completeFn = vi.fn(async () => makeAssistantText("should not be called"));

    const autoChronicler = new AutoChroniclerTs({
      history,
      chronicleStore,
      lifecycle,
      config: {
        model: "openai:gpt-4o-mini",
      },
      completeFn,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    const triggered = await autoChronicler.checkAndChronicle("muaddib", "libera", "#test", 2);

    expect(triggered).toBe(false);
    expect(completeFn).not.toHaveBeenCalled();

    await history.close();
    await chronicleStore.close();
    await rm(dir, { recursive: true, force: true });
  });

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

    const dir = await mkdtemp(join(tmpdir(), "muaddib-chronicle-"));
    const chronicleStore = new ChronicleStore(join(dir, "chronicle.db"));
    await chronicleStore.initialize();

    const lifecycle = new ChronicleLifecycleTs({
      chronicleStore,
      config: {
        model: "openai:gpt-4o-mini",
        paragraphs_per_chapter: 5,
      },
      completeFn: vi.fn(async () => makeAssistantText("Chapter summary paragraph.")),
    });

    const completeFn = vi.fn(async () => makeAssistantText("Auto chronicled paragraph."));

    const autoChronicler = new AutoChroniclerTs({
      history,
      chronicleStore,
      lifecycle,
      config: {
        model: "openai:gpt-4o-mini",
      },
      completeFn,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    const triggered = await autoChronicler.checkAndChronicle("muaddib", "libera", "#test", 2);

    expect(triggered).toBe(true);
    expect(completeFn).toHaveBeenCalledTimes(1);
    expect(await history.countRecentUnchronicled("libera", "#test", 7)).toBe(0);

    const currentChapter = await chronicleStore.renderChapter("libera##test");
    expect(currentChapter).toContain("Auto chronicled paragraph.");

    await history.close();
    await chronicleStore.close();
    await rm(dir, { recursive: true, force: true });
  });
});
