/**
 * RED/GREEN test: internal nudge messages must be ephemeral
 *
 * Rationale
 * ---------
 * The production off-topic misreply bug was traced to internal <meta> reminder
 * and progress nudge messages being injected via agent.steer(). Steered messages
 * go through the pi-agent-core queue and become real entries in agent.state.messages.
 * If a steering message is not consumed before agent_end, it triggers an extra
 * turn — producing an off-topic LLM response that becomes the final reply.
 *
 * Option B fix: move nudges into transformContext, which runs synchronously
 * inside streamAssistantResponse before each LLM call. The nudge is appended
 * ephemerally to the messages slice — it reaches the LLM but is never added
 * to agent.state.messages (i.e. never in session.messages).
 *
 * This single test captures the invariant across both concerns:
 *   1. The LLM DOES receive the nudge in its input context (turn N+1 context
 *      contains a user <meta>...</meta> message after each toolUse turn).
 *   2. session.messages does NOT contain any user messages with <meta> content
 *      after the session completes.
 *
 * RED state (current agent.steer() approach):
 *   Assertion 2 fails: session.messages contains two user messages with <meta>
 *   content — one per toolUse turn.
 *
 * GREEN state (transformContext approach):
 *   Both assertions pass: nudges appear in LLM context but not in session.messages.
 */

import { Type } from "@sinclair/typebox";

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type StreamMockState,
  createStreamMockState,
  handleStreamSimpleCall,
  resetStreamMock,
  textStream,
  toolCallStream,
} from "./e2e/helpers.js";
import { createAgentSessionForInvocation } from "../src/agent/session-factory.js";
import { PiAiModelAdapter } from "../src/models/pi-ai-model-adapter.js";

// ── Mock streamSimple only — real Agent, real AgentSession, real agent loop ──

const mockState: StreamMockState = createStreamMockState();

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    streamSimple: (...args: unknown[]) => handleStreamSimpleCall(mockState, ...args),
  };
});

// ── Helpers ──

function getContextMessages(call: { model: unknown; context: unknown }): unknown[] {
  const ctx = call.context as { messages?: unknown[] };
  return Array.isArray(ctx) ? ctx : (ctx?.messages ?? []);
}

function getMessageText(m: unknown): string {
  if (!m || typeof m !== "object") return "";
  const msg = m as { content?: unknown };
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }
  return "";
}

// ── Test ──

describe("internal nudge ephemerality", () => {
  beforeEach(() => resetStreamMock(mockState));

  it("nudge appears in LLM context but not in session.messages after two toolUse turns", async () => {
    const TOOL_NAME = "ping";
    const META_REMINDER = "Stay focused on the task at hand.";

    // Script 3 LLM responses: toolCall → toolCall → text (two continuation turns).
    // A 4th fallback is provided so the test does not crash with an unhandled
    // rejection when the current (steer-based) implementation makes an extra call;
    // the explicit toHaveLength(3) assertion below surfaces the failure cleanly.
    mockState.responses = [
      toolCallStream({ type: "toolCall", id: "tc1", name: TOOL_NAME, arguments: {} }),
      toolCallStream({ type: "toolCall", id: "tc2", name: TOOL_NAME, arguments: {} }),
      textStream("done"),
      textStream("(spurious extra turn — should not happen)"),
    ];

    const pingTool = {
      name: TOOL_NAME,
      persistType: "none" as const,
      label: "Ping",
      description: "A no-op tool.",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text" as const, text: "pong" }],
        details: {},
      }),
    };

    const authStorage = AuthStorage.inMemory({ openai: { type: "api_key", key: "sk-fake" } });
    const modelAdapter = new PiAiModelAdapter();

    const { session, dispose } = createAgentSessionForInvocation({
      model: "openai:gpt-4o-mini",
      systemPrompt: "You are a bot.",
      tools: [pingTool],
      authStorage,
      modelAdapter,
      maxIterations: 10,
      metaReminder: META_REMINDER,
    });

    try {
      await session.prompt("hello");
    } finally {
      dispose();
    }

    // ── Assert: exactly 3 LLM calls, no extra turn from leftover steer message ──
    expect(mockState.calls).toHaveLength(3);

    // ── Assert: LLM call #2 received the <meta> nudge in its context ──
    // (after the first toolUse turn, the nudge must be visible to the LLM)
    const call2Messages = getContextMessages(mockState.calls[1]);
    const nudgeInCall2 = call2Messages.find(
      (m) =>
        (m as any).role === "user" &&
        getMessageText(m).includes(META_REMINDER) &&
        getMessageText(m).includes("<meta>"),
    );
    expect(nudgeInCall2).toBeDefined();

    // ── Assert: LLM call #3 received the <meta> nudge in its context ──
    // (after the second toolUse turn, still injected — not suppressed)
    const call3Messages = getContextMessages(mockState.calls[2]);
    const nudgeInCall3 = call3Messages.find(
      (m) =>
        (m as any).role === "user" &&
        getMessageText(m).includes(META_REMINDER) &&
        getMessageText(m).includes("<meta>"),
    );
    expect(nudgeInCall3).toBeDefined();

    // ── Core assertion: no <meta> user messages in session.messages ──
    //
    // RED (current agent.steer()): steered messages get appendMessage()'d
    // by the agent loop → they appear in session.messages as real user turns.
    //
    // GREEN (transformContext): nudge is added ephemerally inside
    // streamAssistantResponse — reaches the LLM but never touches agent.state.messages.
    const metaUserMessages = (session.messages as unknown[]).filter(
      (m) => (m as any).role === "user" && getMessageText(m).includes("<meta>"),
    );
    expect(metaUserMessages).toHaveLength(0);
  }, 15_000);
});
