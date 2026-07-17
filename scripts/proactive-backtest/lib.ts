/**
 * Proactive interjection backtest — shared pure logic.
 *
 * The backtest replays historical proactive "serious stage" decisions (the
 * agent run that either interjects or responds with the NULL sentinel)
 * against candidate models/prompts, using the production model's logged
 * decisions as a silver standard.
 *
 * See scripts/proactive-backtest/README.md for the workflow.
 */

import { createHash } from "node:crypto";

import { isNullSentinel } from "../../src/rooms/command/command-executor.js";
import {
  detectRefusalErrorSignal,
  detectRefusalSignal,
} from "../../src/agent/refusal-detection.js";

// ── Types ──

export interface DatasetMessage {
  role: "user" | "assistant";
  text: string;
}

export type SilverLabel = "interject" | "null";

export interface DatasetExample {
  /** Stable id — relative path of the source log file. */
  id: string;
  /** Arc, e.g. "libera###chemistry" (parsed from log lines when available). */
  arc: string;
  /** Silver-standard label from the production model's logged decision. */
  label: SilverLabel;
  /** Production model that produced the silver label (e.g. claude-opus-4-5). */
  silverModel: string;
  /** First line of the delivered response ("interject" cases only). */
  deliveredSnippet?: string;
  /** Serious-stage system prompt (persona + proactive NOTE), workspace noise stripped. */
  systemPrompt: string;
  /** Conversation context replayed to candidates. */
  messages: DatasetMessage[];
  /** Number of agent_stream payloads in the log (>2 implies tool use before decision). */
  agentStreamCount: number;
}

export interface ExtractSkip {
  id: string;
  reason: string;
}

export type Decision = "interject" | "null" | "refusal" | "error";

export interface DecisionResult {
  decision: Decision;
  /** Cleaned response text (interject) or diagnostic detail (refusal/error). */
  text: string;
}

// ── Log parsing ──

export interface LlmIoBlock {
  kind: "payload" | "response";
  callType: string;
  json: Record<string, unknown>;
  /** 0-based line index of the block header in the log file. */
  line: number;
}

const LLM_IO_HEADER = /llm_io (payload|response) (\w+) \{$/;

/**
 * Parse `llm_io payload/response <callType> {...}` blocks out of a muaddib
 * debug log. The JSON body is pretty-printed with 2-space indent, so the
 * closing `}` at column 0 terminates a block.
 */
export function parseLlmIoBlocks(logText: string): LlmIoBlock[] {
  const lines = logText.split("\n");
  const blocks: LlmIoBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LLM_IO_HEADER.exec(lines[i]);
    if (!m) continue;
    const headerLine = i;
    const body = ["{"];
    i++;
    while (i < lines.length && lines[i] !== "}") {
      body.push(lines[i]);
      i++;
    }
    body.push("}");
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(body.join("\n")) as Record<string, unknown>;
    } catch {
      continue; // truncated/corrupt block — skip
    }
    blocks.push({ kind: m[1] as "payload" | "response", callType: m[2], json, line: headerLine });
  }
  return blocks;
}

// ── Example extraction ──

interface ContentPart {
  type?: string;
  text?: string;
}

function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentPart[])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

const THINKING_RE = /<thinking>[\s\S]*?<\/thinking>/g;
const TRAILING_NULL_RE = /\n["'`]?\s*null\s*["'`]?\s*$/iu;

/** Does an agent_stream response contain an (explicit) NULL decision? */
function responseIsNull(json: Record<string, unknown>): boolean {
  const text = partsText(json.content).replace(THINKING_RE, "").trim();
  return text.length > 0 && isNullSentinel(text);
}

/**
 * Truncate the logged serious-stage system prompt at the runner-appended
 * workspace section. Keeps persona + proactive NOTE; drops session dirs,
 * skills, memory — per-session noise the backtest replay can't honour anyway.
 */
export function canonicalizeSystemPrompt(system: string): string {
  const cut = system.indexOf("\n\nFilesystem:");
  return cut >= 0 ? system.slice(0, cut) : system;
}

/**
 * Extract a backtest example from a proactive session log, or a skip record
 * when the log does not contain an unambiguous silver decision.
 */
export function extractExample(
  logText: string,
  id: string,
): { example?: DatasetExample; skip?: ExtractSkip } {
  const interjectingIdx = logText.indexOf("Interjecting proactively");
  if (interjectingIdx < 0) {
    return { skip: { id, reason: "no-interjecting-marker" } };
  }
  const arcMatch = /Interjecting proactively arc=(\S+)/.exec(logText);
  const arc = arcMatch?.[1] ?? "unknown";

  const blocks = parseLlmIoBlocks(logText);
  const agentPayloads = blocks.filter((b) => b.kind === "payload" && b.callType === "agent_stream");
  const agentResponses = blocks.filter((b) => b.kind === "response" && b.callType === "agent_stream");
  const first = agentPayloads[0];
  if (!first) {
    return { skip: { id, reason: "no-agent-payload" } };
  }

  const silverModel = String(first.json.model ?? "unknown");
  // If the session involved multiple models (refusal fallback retried with a
  // different model), the final decision cannot be attributed to silverModel.
  const models = new Set(agentPayloads.map((b) => String(b.json.model ?? "unknown")));
  if (models.size > 1) {
    return { skip: { id, reason: `mixed-models-${[...models].sort().join("+")}` } };
  }
  const rawMessages = Array.isArray(first.json.messages) ? first.json.messages : [];
  const messages: DatasetMessage[] = [];
  for (const raw of rawMessages as Array<{ role?: string; content?: unknown }>) {
    if (raw.role !== "user" && raw.role !== "assistant") continue;
    const text = partsText(raw.content);
    if (text) messages.push({ role: raw.role, text });
  }
  if (messages.length === 0) {
    return { skip: { id, reason: "no-context-messages" } };
  }

  const systemRaw = partsText(first.json.system);
  if (!systemRaw) {
    return { skip: { id, reason: "no-system-prompt" } };
  }
  const systemPrompt = canonicalizeSystemPrompt(systemRaw);

  // ── Silver label: only from explicit evidence ──
  const deliveredMatch = /Delivering response arc=\S+ response=(.*)/.exec(logText);
  if (deliveredMatch) {
    return {
      example: {
        id,
        arc,
        label: "interject",
        silverModel,
        deliveredSnippet: deliveredMatch[1],
        systemPrompt,
        messages,
        agentStreamCount: agentPayloads.length,
      },
    };
  }
  // No delivery — require an explicit NULL sentinel in an agent response;
  // errors / rate limits / truncated sessions are ambiguous and excluded.
  const hasExplicitNull = agentResponses.some((b) => responseIsNull(b.json));
  if (hasExplicitNull) {
    return {
      example: {
        id,
        arc,
        label: "null",
        silverModel,
        systemPrompt,
        messages,
        agentStreamCount: agentPayloads.length,
      },
    };
  }
  return { skip: { id, reason: "no-delivery-no-explicit-null" } };
}

// ── Prompt variants ──

export const PROMPT_NOTE_MARKER = "NOTE: This is a proactive interjection";

/**
 * Replace the proactive NOTE (seriousExtra) tail of a system prompt with a
 * variant text. The NOTE is always the final segment of the canonicalized
 * system prompt (executor appends seriousExtra last).
 */
export function applyPromptVariant(systemPrompt: string, variant: string): string {
  const idx = systemPrompt.indexOf(PROMPT_NOTE_MARKER);
  if (idx < 0) {
    throw new Error(`System prompt does not contain the proactive NOTE marker: ${systemPrompt.slice(0, 120)}...`);
  }
  return systemPrompt.slice(0, idx) + variant;
}

// ── Decision classification (mirrors executeQuiet's quiet-output policy) ──

export function classifyDecision(response: {
  text: string;
  stopReason?: string;
  errorMessage?: string;
}): DecisionResult {
  if (response.stopReason === "error") {
    const err = response.errorMessage ?? "";
    const refusal = detectRefusalErrorSignal(err) ?? detectRefusalSignal(response.text);
    if (refusal) return { decision: "refusal", text: `${refusal}: ${err || response.text}` };
    return { decision: "error", text: err || "(error with no message)" };
  }
  const bodyRefusal = detectRefusalSignal(response.text);
  if (bodyRefusal) {
    return { decision: "refusal", text: `${bodyRefusal}: ${response.text}` };
  }
  let cleaned = response.text.replace(THINKING_RE, "").trim();
  if (cleaned.startsWith("Error: ")) {
    // executeQuiet suppresses Error:-prefixed output — treat as an error
    // (excluded from rates), not as a NULL decision.
    return { decision: "error", text: cleaned };
  }
  if (!cleaned || isNullSentinel(cleaned)) {
    return { decision: "null", text: cleaned };
  }
  // Strip trailing NULL sentinel from otherwise valid content.
  cleaned = cleaned.replace(TRAILING_NULL_RE, "").trim();
  if (!cleaned) return { decision: "null", text: "" };
  return { decision: "interject", text: cleaned };
}

// ── Deterministic stratified sampling ──

/**
 * Deterministically sample up to maxPerLabel[label] examples of each label,
 * ordered by sha1(seed + id) so subsets are stable across runs and nested
 * (a smaller cap yields a prefix of a larger cap's selection).
 */
export function sampleDataset(
  examples: DatasetExample[],
  maxPerLabel: Partial<Record<SilverLabel, number>>,
  seed = "backtest-v1",
): DatasetExample[] {
  const keyed = examples.map((ex) => ({
    ex,
    key: createHash("sha1").update(seed + ex.id).digest("hex"),
  }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const taken: Record<string, number> = {};
  const out: DatasetExample[] = [];
  for (const { ex } of keyed) {
    const cap = maxPerLabel[ex.label];
    const count = taken[ex.label] ?? 0;
    if (cap !== undefined && count >= cap) continue;
    taken[ex.label] = count + 1;
    out.push(ex);
  }
  // Stable output order (by id) regardless of hash order.
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}
