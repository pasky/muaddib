/**
 * Real auto-compaction through a real AgentSession.
 *
 * Compaction was unreachable while `maxContextLength` defaulted to 100k (it
 * fires near the model's own context window, always higher than the ceiling),
 * so everything muaddib does around it was untested. Now that the ceiling is
 * gone, compaction is what keeps long sessions alive, and these are the
 * muaddib-side invariants it must not break:
 *
 *   1. It fires, and the preloaded channel context reaches the summarizer
 *      instead of being silently discarded (it must live in session entries,
 *      not just in agent.state.messages).
 *   2. Usage/cost accounting survives it. Compaction truncates
 *      agent.state.messages, so summing usage off the surviving messages
 *      undercounts what was billed — and `maxCostUsd` is now the only bound
 *      on a session.
 *
 * Only `streamSimple` is mocked; Agent, AgentSession, SessionManager and the
 * whole compaction machinery are real.
 */

import { Type } from "typebox";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantMessageEventStream, Usage } from "@earendil-works/pi-ai";

import { AuthStore } from "../src/auth/auth-store.js";
import { textStream, toolCallStream } from "./e2e/helpers.js";
import { createAgentSessionForInvocation } from "../src/agent/session-factory.js";
import { PiAiModelAdapter } from "../src/models/pi-ai-model-adapter.js";
import { sumAssistantUsage } from "../src/cost/usage.js";

const SUMMARY_TEXT = "SUMMARY of the earlier conversation";
const CHANNEL_LINE = "earlier channel line about somatic mutation rates";

/** gpt-4o-mini has a 128k window; compaction triggers above 128k - 16384. */
const THRESHOLD_TURN_TOKENS = 120_000;

const TOOL_TURNS = 6;

function usageOf(totalTokens: number, costTotal: number): Usage {
  return {
    input: totalTokens,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: costTotal, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
}

/**
 * Route each request by what it is rather than by call order: compaction fires
 * from inside the agent loop, so a positional script is fragile.
 */
const llmCalls: Array<{ kind: "agent" | "summarization"; context: { messages: unknown[] } }> = [];
let agentCallCount = 0;

function routeStreamSimple(...args: unknown[]): AssistantMessageEventStream {
  const context = args[1] as { messages: unknown[]; systemPrompt?: string };
  const isSummarization = (context.systemPrompt ?? "").includes("summarization assistant");
  llmCalls.push({ kind: isSummarization ? "summarization" : "agent", context });

  if (isSummarization) {
    return textStream(SUMMARY_TEXT, usageOf(50_000, 0.25))();
  }

  agentCallCount += 1;
  // Several tool-calling turns, each reporting a context past the compaction
  // threshold, then a final answer. Multiple turns matter: compaction can only
  // cut at a user or assistant entry, so a transcript with a single assistant
  // turn has no cut point and is silently left alone.
  return agentCallCount <= TOOL_TURNS
    ? toolCallStream(
        { type: "toolCall", id: `tc${agentCallCount}`, name: "dump", arguments: {} },
        usageOf(THRESHOLD_TURN_TOKENS, 0.5),
      )()
    : textStream("final answer", usageOf(1_000, 0.1))();
}

vi.mock("../src/models/pi-ai-models.js", async () => {
  const { buildPiAiModelsMock } = await import("./pi-ai-models-mock.js");
  return buildPiAiModelsMock({
    streamSimple: (...args: unknown[]) => routeStreamSimple(...args),
  });
});

function messageText(m: unknown): string {
  // Compaction stores its summary on a dedicated message role.
  const summary = (m as { summary?: unknown }).summary;
  if (typeof summary === "string") return summary;
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

describe("auto-compaction", () => {
  beforeEach(() => {
    llmCalls.length = 0;
    agentCallCount = 0;
  });

  it("fires, summarizes the preloaded context, and keeps usage accounting intact", async () => {
    // Roughly one raw web page per tool call (~40k chars ≈ 10k tokens), the
    // shape that actually fills muaddib's context in the field.
    const BULK = "x".repeat(40_000);

    const dumpTool = {
      name: "dump",
      persistType: "none" as const,
      label: "Dump",
      description: "Returns a large payload.",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text" as const, text: BULK }],
        details: {},
      }),
    };

    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const { session, dispose, getUsageSummary } = await createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "You are a bot.",
      tools: [dumpTool],
      authStorage: AuthStore.inMemory({ openai: { type: "api_key", key: "sk-fake" } }),
      modelAdapter: new PiAiModelAdapter(),
      sessionLimits: { maxCostUsd: 100 },
      contextMessages: [{ role: "user", content: CHANNEL_LINE, timestamp: 0 }],
      logger,
    });

    try {
      await session.prompt("what happened?");
    } finally {
      dispose();
    }

    // ── 1. Compaction really ran, and said so ──
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Context compacted"));

    // ── 2. The preloaded channel context reached the summarizer ──
    // Without contextMessages persisted as session entries, the channel line
    // would never appear here — it would just vanish.
    const summarizationCall = llmCalls.find((c) => c.kind === "summarization");
    expect(summarizationCall).toBeDefined();
    const summarizedText = summarizationCall!.context.messages.map(messageText).join("\n");
    expect(summarizedText).toContain(CHANNEL_LINE);

    // ── 3. Compaction truncated live state ──
    const survivingText = (session.messages as unknown[]).map(messageText).join("\n");
    expect(survivingText).toContain(SUMMARY_TEXT);
    expect(survivingText).not.toContain(CHANNEL_LINE);

    // ── 4. Usage accounting survives the truncation ──
    // Billed: 0.5 per tool turn + 0.25 per summarization + 0.1 for the answer.
    const summarizationCount = llmCalls.filter((c) => c.kind === "summarization").length;
    const expectedCost = 0.5 * TOOL_TURNS + 0.25 * summarizationCount + 0.1;
    const summary = getUsageSummary();
    expect(summary.usage.cost.total).toBeCloseTo(expectedCost, 5);
    expect(summary.peakTurnInput).toBe(THRESHOLD_TURN_TOKENS);

    // Summing over surviving messages — the old approach — can see neither the
    // compacted-away turns nor the summarization call.
    expect(sumAssistantUsage(session.messages).usage.cost.total).toBeLessThan(expectedCost);
  }, 30_000);
});
