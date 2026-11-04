/**
 * System prompt split by how often each part changes, most stable first, so
 * providers with explicit prompt caching can reuse the stable prefix across
 * sessions instead of re-writing the whole prompt on every first turn.
 */
export interface SystemPromptParts {
  /** Persona/mode instructions: identical across runs of the same mode, trigger and model (and room prompt vars). */
  mode: string;
  /** Arc workspace context (environment, skills, recall, MEMORY.md): stable until these change. */
  arc?: string;
  /** This run only (session dir, per-user memory, current time, ...): never reused across sessions. */
  run?: string;
}

const PART_SEPARATOR = "\n\n";

/** The prompt as one text, for providers without per-part caching. */
export function joinSystemPrompt(parts: SystemPromptParts): string {
  return [parts.mode, parts.arc, parts.run].filter(Boolean).join(PART_SEPARATOR);
}

interface AnthropicCacheControl {
  type: string;
  ttl?: string;
}

interface AnthropicTextBlock {
  type: string;
  text?: string;
  cache_control?: AnthropicCacheControl;
}

/** The parts of an anthropic-messages request body that cache tiering touches. */
export interface AnthropicCachePayload {
  system?: AnthropicTextBlock[];
  tools?: Array<{ cache_control?: AnthropicCacheControl }>;
}

/**
 * Rewrite an anthropic-messages request so the system prompt is cached in
 * tiers: pi-ai sends it as one block with one breakpoint, which the per-run
 * tail invalidates every session. Instead (with pi-ai's default retention):
 *
 *   tools (1h) → mode (1h) → arc (5m) → run (no own breakpoint) → messages (5m, as before)
 *
 * Anthropic requires longer-TTL breakpoints before shorter ones, hence the
 * tools breakpoint is lifted to 1h too. Breakpoints on earlier system blocks
 * (the OAuth identity block) are dropped: the mode breakpoint covers them, and
 * keeping them would exceed the four-breakpoint limit. Models without 1h
 * cache support keep pi-ai's TTL on every breakpoint.
 *
 * Returns false (payload untouched) when there is nothing to tier (mode part
 * only), caching is off, or the system block does not match `parts` verbatim
 * (e.g. pi-ai stripped unpaired surrogates).
 */
export function applyAnthropicSystemPromptCacheTiers(
  params: AnthropicCachePayload,
  parts: SystemPromptParts,
  supportsLongCache: boolean,
): boolean {
  const system = params.system;
  if (!Array.isArray(system) || !(parts.arc || parts.run)) return false;
  const joined = joinSystemPrompt(parts);
  const index = system.findIndex((block) => block.type === "text" && block.text === joined);
  const cacheControl = index >= 0 ? system[index].cache_control : undefined;
  if (!cacheControl) return false;

  const longCache = supportsLongCache ? { ...cacheControl, ttl: "1h" } : { ...cacheControl };
  // Anthropic rejects cache_control on empty text blocks; skip empty parts entirely.
  const tiered: AnthropicTextBlock[] = [];
  if (parts.mode) tiered.push({ type: "text", text: parts.mode, cache_control: longCache });
  if (parts.arc) tiered.push({ type: "text", text: parts.arc, cache_control: { ...cacheControl } });
  if (parts.run) tiered.push({ type: "text", text: parts.run });

  params.system = [
    ...system.slice(0, index).map(({ cache_control: _dropped, ...block }) => block),
    ...tiered,
    ...system.slice(index + 1),
  ];
  if (supportsLongCache) {
    for (const tool of params.tools ?? []) {
      if (tool.cache_control) tool.cache_control = { ...tool.cache_control, ttl: "1h" };
    }
  }
  return true;
}
