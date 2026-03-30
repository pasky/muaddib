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
} as const;

export type LlmCallType = (typeof LLM_CALL_TYPE)[keyof typeof LLM_CALL_TYPE];

const LLM_CALL_TYPE_VALUES = new Set<LlmCallType>(Object.values(LLM_CALL_TYPE));

export function isLlmCallType(value: string): value is LlmCallType {
  return LLM_CALL_TYPE_VALUES.has(value as LlmCallType);
}
