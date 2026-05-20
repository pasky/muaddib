/**
 * session_query tool — query a previous pi-coding-agent JSONL session file
 * stored under `$MUADDIB_HOME/arcs/<arc>/workspace/.sessions/session-<slug>/`
 * by that 8-char slug.
 *
 * Rather than serialising the stored session to a side prompt, the tool
 * *resumes* the session: it loads the JSONL, reuses the model the original
 * session last ran with, and sends the question as a fresh user turn. This
 * lets the provider's prompt cache hit on the existing message prefix.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  SessionManager,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { getMuaddibHome } from "../../config/paths.js";
import { withCostSpan } from "../../cost/cost-span.js";
import { LLM_CALL_TYPE } from "../../cost/llm-call-type.js";
import { responseText } from "../message.js";
import {
  MUADDIB_SYSTEM_PROMPT_CUSTOM_TYPE,
  MUADDIB_TOOL_SCHEMAS_CUSTOM_TYPE,
  createAgentSessionForInvocation,
} from "../session-factory.js";
import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";
import { isAssistantMessage } from "../message.js";
import type { MuaddibTool, ToolContext } from "./types.js";

export interface SessionQueryInput {
  sessionId: string;
  question: string;
}

const SESSION_RECORD_FILENAME = ".session-record.jsonl";

/**
 * Fallback system prompt used only when the resumed session has no stored
 * system prompt (legacy sessions predating session-factory persistence).
 */
const FALLBACK_QUERY_SYSTEM_PROMPT =
  "You are being asked a quick follow-up question about the session above. Answer concisely and directly based only on what the session contains. If the information isn't present, say so. Do not use any tools; just write a short textual answer.";

const QUESTION_ENVELOPE = (question: string): string =>
  [
    "<meta>Follow-up query from another agent. DO NOT continue the original task.",
    "",
    `Question: ${question}`,
    "",
    "Answer concisely and directly based only on the session above. If the information isn't present, say so. Do not use any tools.",
    "</meta>",
  ].join("\n");

/**
 * Locate a session JSONL file by its short slug.
 *
 * Sessions live alongside the Gondolin workspace at
 * `$MUADDIB_HOME/arcs/<arc>/workspace/.sessions/session-<slug>/.session-record.jsonl`.
 * Searches the requesting arc first, then all other arcs.
 */
export function findSessionFileById(sessionId: string, preferredArc?: string): string | null {
  const trimmed = sessionId.trim();
  if (!trimmed) return null;
  const arcsRoot = join(getMuaddibHome(), "arcs");
  if (!existsSync(arcsRoot)) return null;

  const arcDirs = readdirSync(arcsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const ordered = preferredArc && arcDirs.includes(preferredArc)
    ? [preferredArc, ...arcDirs.filter((name) => name !== preferredArc)]
    : arcDirs;

  // Accept either the bare slug ("abc12345") or the full "session-abc12345"
  // form — either way we look for the matching subdirectory.
  const slug = trimmed.startsWith("session-") ? trimmed.slice("session-".length) : trimmed;
  const dirName = `session-${slug}`;

  const candidates: { full: string; mtime: number }[] = [];
  for (const arcName of ordered) {
    const sessionsRoot = join(arcsRoot, arcName, "workspace", ".sessions");
    const candidate = join(sessionsRoot, dirName, SESSION_RECORD_FILENAME);
    if (existsSync(candidate)) {
      candidates.push({ full: candidate, mtime: statSync(candidate).mtimeMs });
      if (arcName === preferredArc) return candidate;
    }
  }
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.mtime - a.mtime)[0]!.full;
}

/** Pull the last `model_change` entry out of a session's branch, if any. */
function findSessionModelSpec(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type === "model_change") {
      return `${entry.provider}:${entry.modelId}`;
    }
  }
  return null;
}

/** Pull the persisted muaddib system prompt out of a session's branch, if any. */
function findSessionSystemPrompt(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type === "custom" && entry.customType === MUADDIB_SYSTEM_PROMPT_CUSTOM_TYPE) {
      const data = entry.data as { text?: string } | undefined;
      if (data && typeof data.text === "string" && data.text.length > 0) {
        return data.text;
      }
    }
  }
  return null;
}

interface StoredToolSchema {
  name: string;
  description?: string;
  parameters: unknown;
}

function findSessionToolSchemas(entries: SessionEntry[]): StoredToolSchema[] {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type === "custom" && entry.customType === MUADDIB_TOOL_SCHEMAS_CUSTOM_TYPE) {
      const data = entry.data as { schemas?: StoredToolSchema[] } | undefined;
      if (data && Array.isArray(data.schemas)) return data.schemas;
    }
  }
  return [];
}

/**
 * Rebuild a muaddib tool from a stored schema.  Identical shape (name,
 * description, parameters) to the original tool — so the provider sees the
 * same `tools` list and prompt-cache hits — but with a refusal `execute` so
 * if the LLM does try to call it, we fail closed instead of running a real
 * side-effecting tool from inside a read-only query.
 */
function replayStoredTool(schema: StoredToolSchema): MuaddibTool {
  return {
    name: schema.name,
    label: schema.name,
    description: schema.description ?? "",
    // Stored as plain JSON Schema — structurally compatible with TypeBox
    // schemas at the wire level, which is what the provider actually sees.
    parameters: schema.parameters as unknown as MuaddibTool["parameters"],
    persistType: "none",
    execute: async () => ({
      content: [
        {
          type: "text" as const,
          text: "session_query is in read-only mode — tool use is disabled.",
        },
      ],
      details: { readOnly: true },
      isError: true,
    }),
  };
}

export function createSessionQueryTool(options: ToolContext): MuaddibTool {
  const modelAdapter = options.modelAdapter as PiAiModelAdapter;
  const logger = options.logger;

  return {
    name: "session_query",
    persistType: "summary",
    label: "Session Query",
    description:
      "Query a previous muaddib session by its short slug (the 8-char `<id>` in `/workspace/.sessions/session-<id>/`) — ask a specific question and get a concise answer. The query resumes the original session with its original model, so the conversation prefix stays in the provider's prompt cache.",
    parameters: Type.Object({
      sessionId: Type.String({
        description:
          "Short session slug — the 8-char `<id>` in `/workspace/.sessions/session-<id>/` (with or without the `session-` prefix).",
      }),
      question: Type.String({
        description:
          "What you want to know about that session (e.g. 'What files were modified?' or 'What approach was chosen?').",
      }),
    }),
    execute: async (_toolCallId: string, params: SessionQueryInput) => {
      const sessionId = params.sessionId.trim();
      const question = params.question.trim();
      if (!sessionId) {
        return {
          content: [{ type: "text", text: "Error: sessionId must be non-empty." }],
          details: { error: true },
        };
      }
      if (!question) {
        return {
          content: [{ type: "text", text: "Error: question must be non-empty." }],
          details: { error: true },
        };
      }

      const sessionPath = findSessionFileById(sessionId, options.arc);
      if (!sessionPath) {
        return {
          content: [{ type: "text", text: `Error: no session found with id '${sessionId}'.` }],
          details: { error: true, sessionId },
        };
      }

      // Peek at the branch to determine which model the session last ran with.
      let branch: SessionEntry[];
      try {
        branch = SessionManager.open(sessionPath).getBranch();
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error loading session '${sessionId}': ${err}` }],
          details: { error: true, sessionId, sessionPath },
        };
      }

      const hasMessages = branch.some((entry) => entry.type === "message");
      if (!hasMessages) {
        return {
          content: [{ type: "text", text: `Session '${sessionId}' is empty — no messages found.` }],
          details: { empty: true, sessionId, sessionPath },
        };
      }

      const modelSpec = findSessionModelSpec(branch);
      if (!modelSpec) {
        return {
          content: [
            {
              type: "text",
              text: `Error: session '${sessionId}' has no model_change entry — cannot determine which model to query it with.`,
            },
          ],
          details: { error: true, sessionId, sessionPath },
        };
      }

      try {
        const result = await withCostSpan(LLM_CALL_TYPE.SESSION_QUERY, { arc: options.arc }, async () => {
          const resumedSystemPrompt = findSessionSystemPrompt(branch) ?? FALLBACK_QUERY_SYSTEM_PROMPT;
          const replayedTools = findSessionToolSchemas(branch).map(replayStoredTool);
          const ctx = createAgentSessionForInvocation({
            model: modelSpec,
            systemPrompt: resumedSystemPrompt,
            tools: replayedTools,
            authStorage: options.authStorage,
            modelAdapter,
            sessionFile: sessionPath,
            logger,
          });

          const { session } = ctx;
          const preCount = session.messages.length;
          try {
            await ctx.ensureProviderKey(modelAdapter.resolve(modelSpec).spec.provider);
            await session.prompt(QUESTION_ENVELOPE(question));

            const newMessages = session.messages.slice(preCount);
            const lastAssistant = [...newMessages].reverse().find(isAssistantMessage);
            const answer = lastAssistant ? responseText(lastAssistant).trim() : "";
            return { answer };
          } finally {
            await session.dispose();
          }
        });

        if (!result.answer) {
          return {
            content: [
              {
                type: "text",
                text: `Error: session '${sessionId}' produced no answer (model may have declined).`,
              },
            ],
            details: { error: true, sessionId, sessionPath, modelSpec },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `**Query:** ${question}\n\n---\n\n${result.answer}`,
            },
          ],
          details: {
            sessionId,
            sessionPath,
            question,
            modelSpec,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error querying session '${sessionId}': ${err}` }],
          details: { error: true, sessionId, sessionPath },
        };
      }
    },
  };
}
