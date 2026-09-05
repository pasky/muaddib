/**
 * session_query tool — query a previous pi-coding-agent JSONL session file
 * stored under `$MUADDIB_HOME/arcs/<arc>/workspace/.sessions/session-<slug>/`
 * by that 8-char slug, or a nested oracle transcript addressed as
 * `session-<root-slug>/oracle-<slug>`.
 *
 * Rather than serialising the stored session to a side prompt, the tool
 * *resumes* the session: it loads the JSONL, reuses the model the original
 * session last ran with, and sends the question as a fresh user turn. This
 * lets the provider's prompt cache hit on the existing message prefix.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getMuaddibHome } from "../../config/paths.js";
import { recordUsage, withCostSpan } from "../../cost/cost-span.js";
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

const SESSION_QUERY_PARAMETERS = Type.Object({
  sessionId: Type.String({
    description:
      "Session id to query: either the 8-char `<id>` in `/workspace/.sessions/session-<id>/` (with or without `session-`) or a nested oracle id like `session-<id>/oracle-<id>`.",
  }),
  question: Type.String({
    description:
      "What you want to know about that session (e.g. 'What files were modified?' or 'What approach was chosen?').",
  }),
});

const SESSION_RECORD_FILENAME = ".session-record.jsonl";
const VM_SESSIONS_PREFIX = "/workspace/.sessions/";
const SESSION_REF_PATTERN = /^(?:session-)?[0-9a-f]{8}$/u;
const ORACLE_SESSION_REF_PATTERN = /^session-[0-9a-f]{8}\/oracle-[0-9a-f]{8}$/u;

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
 * Locate a session JSONL file by root slug or parent-qualified oracle id.
 *
 * Root command sessions live at
 * `$MUADDIB_HOME/arcs/<arc>/workspace/.sessions/session-<slug>/.session-record.jsonl`.
 * Nested oracle transcripts share the root command working directory and live at
 * `$MUADDIB_HOME/arcs/<arc>/workspace/.sessions/session-<root>/oracle-<slug>.session-record.jsonl`.
 * Searches the requesting arc first, then all other arcs.
 */
export function findSessionFileById(sessionId: string, preferredArc?: string): string | null {
  const relativePath = sessionRecordRelativePath(sessionId);
  if (!relativePath) return null;

  const arcsRoot = join(getMuaddibHome(), "arcs");
  if (!existsSync(arcsRoot)) return null;

  const arcNames = readdirSync(arcsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const orderedArcs = preferredArc && arcNames.includes(preferredArc)
    ? [preferredArc, ...arcNames.filter((name) => name !== preferredArc)]
    : arcNames;

  for (const arcName of orderedArcs) {
    const candidate = join(arcsRoot, arcName, "workspace", ".sessions", relativePath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sessionRecordRelativePath(sessionId: string): string | null {
  let id = sessionId.trim();
  if (id.startsWith(VM_SESSIONS_PREFIX)) {
    id = id.slice(VM_SESSIONS_PREFIX.length);
  }
  if (id.endsWith("/")) {
    id = id.slice(0, -1);
  }

  if (SESSION_REF_PATTERN.test(id)) {
    return join(id.startsWith("session-") ? id : `session-${id}`, SESSION_RECORD_FILENAME);
  }
  if (ORACLE_SESSION_REF_PATTERN.test(id)) {
    return `${id}.session-record.jsonl`;
  }
  return null;
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

export function createSessionQueryTool(options: ToolContext): MuaddibTool<typeof SESSION_QUERY_PARAMETERS> {
  const modelAdapter = options.modelAdapter as PiAiModelAdapter;
  const logger = options.logger;

  return {
    name: "session_query",
    persistType: "summary",
    label: "Session Query",
    description:
      "Query a previous muaddib session by its id — either the 8-char `<id>` in `/workspace/.sessions/session-<id>/` or a parent-qualified nested oracle id like `session-<id>/oracle-<id>`. Ask a specific question and get a concise answer. The query resumes the original session with its original model, so the conversation prefix stays in the provider's prompt cache.",
    parameters: SESSION_QUERY_PARAMETERS,
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
          const ctx = await createAgentSessionForInvocation({
            model: modelSpec,
            systemPrompt: resumedSystemPrompt,
            tools: replayedTools,
            authStorage: options.authStorage,
            modelAdapter,
            sessionFile: sessionPath,
            logger,
          });

          const { session } = ctx;
          // Identify the answer by message identity, not by list offset: pi may
          // auto-compact the resumed transcript at the start of this prompt,
          // rewriting session.messages.
          const lastResumed = [...session.messages].reverse().find(isAssistantMessage);
          try {
            await ctx.ensureProviderKey((await modelAdapter.resolve(modelSpec)).spec.provider);
            await session.prompt(QUESTION_ENVELOPE(question));

            const lastAssistant = [...session.messages].reverse().find(isAssistantMessage);
            const answer = lastAssistant && lastAssistant !== lastResumed ? responseText(lastAssistant).trim() : "";
            return { answer };
          } finally {
            recordUsage(LLM_CALL_TYPE.SESSION_QUERY, modelSpec, ctx.takeUsage().usage);
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
