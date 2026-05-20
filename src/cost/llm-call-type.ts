/**
 * Execution source — identifies *why* an LLM call happened.
 * Persisted as the `source` field on cost JSONL rows.
 */
export const COST_SOURCE = {
  /** Direct user command (!s, !c, etc.) */
  EXECUTE: "execute",
  /** Event-triggered execution */
  EVENT: "event",
  /** Proactive interjection */
  PROACTIVE: "proactive",
  /** Background auto-chronicler */
  AUTOCHRONICLER: "autochronicler",
} as const;

export type CostSource = (typeof COST_SOURCE)[keyof typeof COST_SOURCE];

export const LLM_CALL_TYPE = {
  MODE_CLASSIFIER: "mode_classifier",
  CONTEXT_REDUCER: "context_reducer",
  AGENT_RUN: "agent_run",
  ORACLE: "oracle",
  DEEP_RESEARCH: "deep_research",
  VISIT_WEBPAGE: "visit_webpage",
  MEMORY_UPDATE: "memory_update",
  TOOL_SUMMARY: "tool_summary",
  PROACTIVE_VALIDATION: "proactive_validation",
  AUTOCHRONICLER_APPEND: "autochronicler_append",
  CHAPTER_SUMMARY: "chapter_summary",
  GENERATE_IMAGE: "generate_image",
  SESSION_QUERY: "session_query",
} as const;

export type LlmCallType = (typeof LLM_CALL_TYPE)[keyof typeof LLM_CALL_TYPE];

const LLM_CALL_TYPE_VALUES = new Set<LlmCallType>(Object.values(LLM_CALL_TYPE));

export function isLlmCallType(value: string): value is LlmCallType {
  return LLM_CALL_TYPE_VALUES.has(value as LlmCallType);
}
