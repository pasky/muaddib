/**
 * Shared refusal detection for agent responses.
 *
 * Used by SessionRunner to detect refusals and trigger fallback model retry.
 */

const REFUSAL_SIGNAL_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
}> = [
  {
    label: "structured_refusal",
    pattern: /["']is_refusal["']\s*:\s*true/iu,
  },
  {
    label: "python_refusal_message",
    pattern: /the ai refused to respond to this request/iu,
  },
  {
    label: "openai_invalid_prompt_safety",
    pattern: /invalid_prompt[\s\S]{0,160}safety reasons/iu,
  },
  {
    label: "content_safety_refusal",
    pattern: /content safety refusal/iu,
  },
];

/**
 * Detect a refusal signal in text (response body or error message).
 * Returns the matched signal label, or null if no refusal detected.
 */
export function detectRefusalSignal(text: string): string | null {
  const candidate = text.trim();
  if (candidate.length === 0) {
    return null;
  }

  for (const signal of REFUSAL_SIGNAL_PATTERNS) {
    if (signal.pattern.test(candidate)) {
      return signal.label;
    }
  }

  return null;
}
