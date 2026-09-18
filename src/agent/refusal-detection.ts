/**
 * Shared refusal detection for agent responses.
 *
 * Used by SessionRunner to detect refusals and trigger fallback model retry.
 */

interface RefusalPattern {
  label: string;
  pattern: RegExp;
}

// Matched against response body text (and thrown-error strings).
const REFUSAL_SIGNAL_PATTERNS: ReadonlyArray<RefusalPattern> = [
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
    // Matches both the JSON error code (invalid_prompt) and the human-readable
    // "Invalid prompt: ... for safety reasons." message, in either field order.
    pattern: /invalid[_ ]prompt[\s\S]{0,160}safety reasons/iu,
  },
  {
    label: "content_safety_refusal",
    pattern: /content safety refusal/iu,
  },
];

// Matched only against an errorMessage (stopReason "error"), never body text —
// otherwise a legit answer mentioning these phrases would trigger a fallback.
const ERROR_REFUSAL_SIGNAL_PATTERNS: ReadonlyArray<RefusalPattern> = [
  ...REFUSAL_SIGNAL_PATTERNS,
  {
    // Anthropic stop_reason "refusal" → stopReason "error" + this errorMessage.
    label: "anthropic_refusal",
    pattern: /reduce refusals for your users|refusals-and-fallback|the model refused to complete the request/iu,
  },
  {
    // OpenAI content filter: stopReason "error" + this errorMessage.
    label: "openai_cybersecurity_flag",
    pattern: /flagged for possible cybersecurity risk/iu,
  },
];

function matchFirst(text: string, patterns: ReadonlyArray<RefusalPattern>): string | null {
  const candidate = text.trim();
  if (candidate.length === 0) {
    return null;
  }
  for (const signal of patterns) {
    if (signal.pattern.test(candidate)) {
      return signal.label;
    }
  }
  return null;
}

/**
 * Detect a refusal signal in response body text (or a thrown-error string).
 * Returns the matched signal label, or null if no refusal detected.
 */
export function detectRefusalSignal(text: string): string | null {
  return matchFirst(text, REFUSAL_SIGNAL_PATTERNS);
}

/**
 * Detect a refusal signal in an assistant message's errorMessage (stopReason
 * "error"). Includes provider-specific error phrases that must not be matched
 * against body text.
 */
export function detectRefusalErrorSignal(text: string): string | null {
  return matchFirst(text, ERROR_REFUSAL_SIGNAL_PATTERNS);
}

/** Prefix SessionRunner uses when it turns a detected refusal into an error. */
export const REFUSAL_ERROR_PREFIX = "Model refused the request: ";

/**
 * Extract the provider's refusal reason from an error thrown by SessionRunner,
 * or null if the error is not a refusal.
 */
export function extractRefusalReason(errorText: string): string | null {
  const index = errorText.indexOf(REFUSAL_ERROR_PREFIX);
  return index === -1 ? null : errorText.slice(index + REFUSAL_ERROR_PREFIX.length);
}
