import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── streamSimple mock ────────────────────────────────────────────────────
// Capture every Context that hits the provider so we can assert the cached
// prefix (systemPrompt + tools + messages) is byte-identical between the
// original session's last request and session_query's follow-up request.

interface CapturedContext {
  systemPrompt?: string;
  messages: unknown[];
  tools: unknown[];
}

// Vitest evaluates vi.mock factories in a separate module-graph context, so
// test-body closures over a plain `const captured = []` aren't always the
// same reference as what the mock factory sees.  Park the capture array on
// `globalThis` so both contexts share identity.
const globalAny = globalThis as unknown as { __sessionQueryCaptured?: CapturedContext[] };
if (!globalAny.__sessionQueryCaptured) {
  globalAny.__sessionQueryCaptured = [];
}
const captured: CapturedContext[] = globalAny.__sessionQueryCaptured;

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  const streamSimple = (_model: unknown, context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] }, _options?: unknown) => {
    const g = globalThis as unknown as { __sessionQueryCaptured?: { systemPrompt?: string; messages: unknown[]; tools: unknown[] }[] };
    if (!g.__sessionQueryCaptured) {
      g.__sessionQueryCaptured = [];
    }
    // Tools carry non-cloneable `execute` functions.  Snapshot only the
    // serialized shape — which is what the provider actually receives.
    const snapshotTools = (context.tools ?? []).map((t: any) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    g.__sessionQueryCaptured.push({
      systemPrompt: context.systemPrompt,
      messages: JSON.parse(JSON.stringify(context.messages)),
      tools: JSON.parse(JSON.stringify(snapshotTools)),
    });
    const stream = actual.createAssistantMessageEventStream();
    const message = actual.fauxAssistantMessage("canned faux reply", { stopReason: "stop" });
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  };
  return { ...actual, streamSimple, stream: streamSimple };
});

import { PiAiModelAdapter } from "../src/models/pi-ai-model-adapter.js";
import {
  createSessionQueryTool,
  findSessionFileById,
} from "../src/agent/tools/session-query.js";
import {
  MUADDIB_SYSTEM_PROMPT_CUSTOM_TYPE,
  MUADDIB_TOOL_SCHEMAS_CUSTOM_TYPE,
  createAgentSessionForInvocation,
} from "../src/agent/session-factory.js";
import type { MuaddibTool } from "../src/agent/tools/types.js";

let muaddibHome: string;
const originalMuaddibHome = process.env.MUADDIB_HOME;

beforeEach(async () => {
  muaddibHome = await mkdtemp(join(tmpdir(), "muaddib-session-query-"));
  process.env.MUADDIB_HOME = muaddibHome;
  captured.length = 0;
});

afterEach(async () => {
  process.env.MUADDIB_HOME = originalMuaddibHome;
  await rm(muaddibHome, { recursive: true, force: true });
});

async function writeMinimalRecord(arc: string, slug: string): Promise<string> {
  const dir = join(muaddibHome, "arcs", arc, "workspace", ".sessions", `session-${slug}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, ".session-record.jsonl");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, "{}\n");
  return path;
}

describe("findSessionFileById", () => {
  it("returns null when the arcs directory doesn't exist", () => {
    expect(findSessionFileById("abc12345")).toBeNull();
  });

  it("returns null when no matching session slug is stored", async () => {
    await writeMinimalRecord("alpha", "deadbeef");
    expect(findSessionFileById("missing1")).toBeNull();
  });

  it("finds a session by its short slug across arcs", async () => {
    const expected = await writeMinimalRecord("libera##test", "abc12345");
    expect(findSessionFileById("abc12345")).toBe(expected);
  });

  it("accepts the slug with or without the `session-` prefix", async () => {
    const expected = await writeMinimalRecord("libera##test", "abc12345");
    expect(findSessionFileById("session-abc12345")).toBe(expected);
  });

  it("prefers the supplied arc when the slug exists in multiple arcs", async () => {
    await writeMinimalRecord("other", "dup00001");
    const preferred = await writeMinimalRecord("preferred", "dup00001");
    expect(findSessionFileById("dup00001", "preferred")).toBe(preferred);
  });

  it("trims whitespace and rejects empty ids", () => {
    expect(findSessionFileById("   ")).toBeNull();
  });
});

describe("session_query prompt-cache prefix guarantee", () => {
  it("sends a follow-up whose systemPrompt + tools + stored messages are byte-identical to what the original session ended with", async () => {
    const arc = "testsrv##chan";
    const slug = "cacheabc";
    const dir = join(muaddibHome, "arcs", arc, "workspace", ".sessions", `session-${slug}`);
    await mkdir(dir, { recursive: true });
    const sessionFile = join(dir, ".session-record.jsonl");

    const authStorage = AuthStorage.inMemory({
      anthropic: { type: "api_key", key: "unit-test" },
    });
    const modelAdapter = new PiAiModelAdapter({ authStorage });

    // Two tools with real TypeBox schemas — exactly how the baseline builds them.
    const searchTool: MuaddibTool = {
      name: "web_search",
      label: "Web Search",
      description: "Search the web.",
      parameters: Type.Object({
        query: Type.String({ description: "query" }),
      }),
      persistType: "summary",
      execute: async () => ({ content: [{ type: "text", text: "n/a" }], details: {} }),
    };
    const readTool: MuaddibTool = {
      name: "read",
      label: "Read",
      description: "Read a workspace file.",
      parameters: Type.Object({
        path: Type.String({ description: "path" }),
      }),
      persistType: "none",
      execute: async () => ({ content: [{ type: "text", text: "n/a" }], details: {} }),
    };
    const originalSystemPrompt =
      "You are Muaddib, ruler of Arrakis. Current arc: testsrv##chan. Stay on mission.";

    // ── Phase 1: run the original session through a real createAgentSessionForInvocation ──
    const origCtx = createAgentSessionForInvocation({
      model: "anthropic:claude-sonnet-4-5",
      systemPrompt: originalSystemPrompt,
      tools: [searchTool, readTool],
      authStorage,
      modelAdapter,
      sessionFile,
    });
    await origCtx.ensureProviderKey("anthropic");
    await origCtx.session.prompt("what is the state of Arrakis?");
    await origCtx.session.dispose();

    expect(captured).toHaveLength(1);
    const originalReq = captured[0]!;

    // Sanity: the mocked provider saw the real systemPrompt + tools + one user message.
    expect(originalReq.systemPrompt).toBe(originalSystemPrompt);
    expect((originalReq.tools as any[]).map((t) => t.name)).toEqual(["web_search", "read"]);
    expect(originalReq.messages).toHaveLength(1);
    expect((originalReq.messages[0] as any).role).toBe("user");

    // Session record on disk must include the persisted prompt and tool schemas.
    const recordText = await readFile(sessionFile, "utf8");
    expect(recordText).toContain(MUADDIB_SYSTEM_PROMPT_CUSTOM_TYPE);
    expect(recordText).toContain(MUADDIB_TOOL_SCHEMAS_CUSTOM_TYPE);

    // Snapshot the session's recorded messages at end-of-phase-1 — this is
    // the frozen prefix that the follow-up must replay verbatim.  (If we read
    // these *after* session_query runs, they would also include session_query's
    // own user+assistant entries.)
    const persistedAtEndOfPhase1 = SessionManager.open(sessionFile)
      .getBranch()
      .filter((entry) => entry.type === "message")
      .map((entry: any) => entry.message);
    expect(persistedAtEndOfPhase1).toHaveLength(2);

    // ── Phase 2: resume via session_query ─────────────────────────────────
    const tool = createSessionQueryTool({
      authStorage,
      modelAdapter,
      arc,
    });
    await tool.execute!("tc-1", { sessionId: slug, question: "recap please" });
    expect(captured).toHaveLength(2);
    const followUpReq = captured[1]!;

    // ── Byte-identical prefix assertion ───────────────────────────────────
    // For the provider's prompt cache to hit, the serialized request must share
    // a common prefix with the original. That prefix is: systemPrompt + tools +
    // every message from the original session (in order). The follow-up adds a
    // new user turn after that prefix — and nothing new before it.
    const normalizeTools = (tools: unknown[]): unknown[] =>
      tools.map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters }));

    expect(followUpReq.systemPrompt).toBe(originalReq.systemPrompt);
    expect(normalizeTools(followUpReq.tools)).toEqual(normalizeTools(originalReq.tools));

    // The follow-up's messages are exactly the session's end-of-phase-1 state
    // (the user + assistant pair that closed the original session) followed by
    // exactly one new user turn (the question envelope).
    expect(followUpReq.messages).toHaveLength(persistedAtEndOfPhase1.length + 1);
    const followUpPrefix = followUpReq.messages.slice(0, persistedAtEndOfPhase1.length);
    expect(JSON.stringify(followUpPrefix)).toBe(JSON.stringify(persistedAtEndOfPhase1));

    // Full byte-level prefix sanity: serialize the cacheable portion of each
    // request identically and require the follow-up to start with exactly the
    // original's bytes.
    // Final byte-level check on the cacheable prefix of the two requests.
    // Prefix = systemPrompt + tools + all messages recorded at end-of-phase-1.
    // (`originalReq.messages` shows only the user turn because the assistant
    // reply was the *response* to that call, not part of its input. So we
    // compare against the session record's end state instead.)
    const cacheablePrefix = (systemPrompt: string | undefined, tools: unknown[], messages: unknown[]): string =>
      JSON.stringify({ systemPrompt, tools: normalizeTools(tools), messages });
    const originalEnd = cacheablePrefix(
      originalReq.systemPrompt,
      originalReq.tools,
      persistedAtEndOfPhase1,
    );
    const followUpStart = cacheablePrefix(
      followUpReq.systemPrompt,
      followUpReq.tools,
      followUpReq.messages.slice(0, persistedAtEndOfPhase1.length),
    );
    expect(followUpStart).toBe(originalEnd);
  });
});
