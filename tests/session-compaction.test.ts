/**
 * Real auto-compaction through a real SessionRunner + AgentSession.
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
 *   3. Follow-up prompts on the finished session (memory update, tool summary)
 *      still find their reply and bill exactly their own usage when compaction
 *      lands inside them — which is the likely place for it after a long run.
 *
 * Only `streamSimple` is mocked; SessionRunner, Agent, AgentSession,
 * SessionManager and the whole compaction machinery are real.
 */

import { Type } from "typebox";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantMessageEventStream, Usage } from "@earendil-works/pi-ai";

import { AuthStore } from "../src/auth/auth-store.js";
import { textStream, toolCallStream } from "./e2e/helpers.js";
import { SessionRunner } from "../src/agent/session-runner.js";
import { PiAiModelAdapter } from "../src/models/pi-ai-model-adapter.js";
import { withCostSpan } from "../src/cost/cost-span.js";
import { LLM_CALL_TYPE } from "../src/cost/llm-call-type.js";
import { sumAssistantUsage } from "../src/cost/usage.js";

const SUMMARY_TEXT = "SUMMARY of the earlier conversation";
const CHANNEL_LINE = "earlier channel line about somatic mutation rates";
const FOLLOW_UP_REPLY = "Memory updated with the mutation-rate discussion.";

/** gpt-4o-mini has a 128k window; compaction triggers above 128k - 16384. */
const THRESHOLD_TURN_TOKENS = 120_000;

const TOOL_TURNS = 6;
/** A memory update realistically calls tools (it writes files) before replying. */
const FOLLOW_UP_TOOL_TURNS = 2;
const TOOL_TURN_COST = 0.5;
const SUMMARIZATION_COST = 0.25;
const FINAL_ANSWER_COST = 0.1;
const FOLLOW_UP_COST = 0.7;

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
let followUpCallCount = 0;
let phase: "main" | "followUp" = "main";

function routeStreamSimple(...args: unknown[]): AssistantMessageEventStream {
  const context = args[1] as { messages: unknown[]; systemPrompt?: string };
  const isSummarization = (context.systemPrompt ?? "").includes("summarization assistant");
  llmCalls.push({ kind: isSummarization ? "summarization" : "agent", context });

  if (isSummarization) {
    return textStream(SUMMARY_TEXT, usageOf(50_000, SUMMARIZATION_COST))();
  }

  if (phase === "followUp") {
    // The follow-up's turns land past the threshold, so compaction fires
    // inside the follow-up prompt. It needs enough new material since the last
    // compaction (pi keeps the most recent 20k tokens verbatim), hence the
    // tool calls: a follow-up consisting of one short reply is left alone.
    followUpCallCount += 1;
    return followUpCallCount <= FOLLOW_UP_TOOL_TURNS
      ? toolCallStream(
          { type: "toolCall", id: `fu${followUpCallCount}`, name: "dump", arguments: {} },
          usageOf(THRESHOLD_TURN_TOKENS, FOLLOW_UP_COST),
        )()
      : textStream(FOLLOW_UP_REPLY, usageOf(THRESHOLD_TURN_TOKENS, FOLLOW_UP_COST))();
  }

  agentCallCount += 1;
  // Several tool-calling turns, each reporting a context past the compaction
  // threshold, then a final answer. Multiple turns matter: compaction can only
  // cut at a user or assistant entry, so a transcript with a single assistant
  // turn has no cut point and is silently left alone.
  return agentCallCount <= TOOL_TURNS
    ? toolCallStream(
        { type: "toolCall", id: `tc${agentCallCount}`, name: "dump", arguments: {} },
        usageOf(THRESHOLD_TURN_TOKENS, TOOL_TURN_COST),
      )()
    : textStream("final answer", usageOf(1_000, FINAL_ANSWER_COST))();
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

function summarizationCalls(): number {
  return llmCalls.filter((c) => c.kind === "summarization").length;
}

describe("auto-compaction", () => {
  beforeEach(() => {
    llmCalls.length = 0;
    agentCallCount = 0;
    followUpCallCount = 0;
    phase = "main";
  });

  it("fires, summarizes the preloaded context, keeps usage accounting intact, and survives follow-ups", async () => {
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
    const delivered: string[] = [];

    const runner = new SessionRunner({
      model: "openai:gpt-4o-mini",
      systemPrompt: "You are a bot.",
      toolSet: { tools: [dumpTool] },
      authStorage: AuthStore.inMemory({ openai: { type: "api_key", key: "sk-fake" } }),
      modelAdapter: new PiAiModelAdapter(),
      sessionLimits: { maxCostUsd: 100 },
      onResponse: (text) => { delivered.push(text); },
      logger,
    });

    const { result, mainSpan } = await withCostSpan(LLM_CALL_TYPE.AGENT_RUN, {}, async (span) => ({
      result: await runner.prompt("what happened?", {
        contextMessages: [{ role: "user", content: CHANNEL_LINE, timestamp: 0 }],
      }),
      mainSpan: span,
    }));
    const session = result.session!;

    try {
      // ── 1. Compaction really ran, and said so ──
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Context compacted"));
      expect(result.text).toBe("final answer");
      expect(delivered).toEqual(["final answer"]);

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
      const mainSummarizations = summarizationCalls();
      const expectedMainCost =
        TOOL_TURN_COST * TOOL_TURNS + SUMMARIZATION_COST * mainSummarizations + FINAL_ANSWER_COST;
      expect(result.usage.cost.total).toBeCloseTo(expectedMainCost, 5);
      expect(result.peakTurnInput).toBe(THRESHOLD_TURN_TOKENS);
      expect(mainSpan.allEntries().map((e) => [e.callType, e.usage.cost.total])).toEqual([
        [LLM_CALL_TYPE.AGENT_RUN, expect.closeTo(expectedMainCost, 5)],
      ]);

      // Summing over surviving messages — the old approach — can see neither the
      // compacted-away turns nor the summarization call.
      expect(sumAssistantUsage(session.messages).usage.cost.total).toBeLessThan(expectedMainCost);

      // ── 5. A follow-up prompt that itself triggers compaction ──
      // pi ignores usage from assistant messages not newer (ms resolution) than
      // the last compaction entry; the mocked main run finishes within one ms.
      await new Promise((resolve) => setTimeout(resolve, 5));
      phase = "followUp";
      const { reply, followUpSpan } = await withCostSpan(LLM_CALL_TYPE.MEMORY_UPDATE, {}, async (span) => ({
        reply: await result.followUp!("<meta>Session complete. Update memory.</meta>"),
        followUpSpan: span,
      }));
      const followUpSummarizations = summarizationCalls() - mainSummarizations;
      expect(followUpSummarizations).toBeGreaterThan(0);

      // The reply is found even though compaction rewrote session.messages, and
      // nothing from the follow-up was delivered to the channel.
      expect(reply).toBe(FOLLOW_UP_REPLY);
      expect(delivered).toEqual(["final answer"]);

      // Exactly the follow-up's share is billed: its own turns plus the
      // summarization it triggered, none of the main run.
      const expectedFollowUpCost =
        FOLLOW_UP_COST * (FOLLOW_UP_TOOL_TURNS + 1) + SUMMARIZATION_COST * followUpSummarizations;
      expect(followUpSpan.allEntries().map((e) => [e.callType, e.usage.cost.total])).toEqual([
        [LLM_CALL_TYPE.MEMORY_UPDATE, expect.closeTo(expectedFollowUpCost, 5)],
      ]);
    } finally {
      await session.dispose();
    }
  }, 30_000);
});
