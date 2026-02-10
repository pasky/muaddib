import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChronicleStore } from "../src/chronicle/chronicle-store.js";
import { ChatHistoryStore } from "../src/history/chat-history-store.js";

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

    await store.close();
  });
});
