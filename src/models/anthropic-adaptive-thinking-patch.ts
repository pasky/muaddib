/**
 * Monkeypatch: force adaptive thinking in Anthropic requests for Opus 4.6+ /
 * Sonnet 4.6+ models that pi-ai's internal `supportsAdaptiveThinking()` hasn't
 * been updated to recognize (e.g. opus-4-7, sonnet-4-7).
 *
 * Why this exists:
 * - Anthropic's API rejects `thinking: {type: "enabled", budget_tokens: ...}` for
 *   opus-4-7+ when auth uses a plain API key:
 *   `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" ...`
 *   (standalone `pi` doesn't hit this because it uses OAuth + the `claude-code-20250219`
 *   beta header, which Anthropic lets through; muaddib uses a plain API key.)
 * - pi-ai's `supportsAdaptiveThinking` is a non-exported local function that string-
 *   matches only `opus-4-6` / `opus-4.6` / `sonnet-4-6` / `sonnet-4.6`. Newer ids
 *   (opus-4-7, sonnet-4-7, ...) fall into the budget-based branch. Because the
 *   function isn't exported, we can't replace it at runtime — but pi-ai *does*
 *   call `options.onPayload(params, model)` after building the Anthropic request
 *   body, and uses its return value to replace `params` before sending. That's
 *   our escape hatch.
 *
 * Fix: re-register the `anthropic-messages` API provider with a streamSimple
 * wrapper that composes an `onPayload` which rewrites the thinking config from
 * `{type: "enabled", budget_tokens: ...}` to `{type: "adaptive"}` +
 * `output_config: {effort: ...}` for opus-4-N / sonnet-4-N models with N >= 6.
 * A caller-supplied `onPayload` is chained; its return value is adapted after ours.
 *
 * Drop this module once pi-ai's supportsAdaptiveThinking is updated to cover
 * opus-4-7+ / sonnet-4-7+.
 */
import {
  getApiProvider,
  registerApiProvider,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from "@mariozechner/pi-ai";

const ADAPTIVE_API = "anthropic-messages" as const;

interface AnthropicRequestParamsWithThinking {
  thinking?: unknown;
  output_config?: unknown;
  max_tokens?: number;
  // ...other fields we don't touch
  [key: string]: unknown;
}

function needsAdaptiveOverride(modelId: string): boolean {
  // Match opus-4-N or opus-4.N / sonnet-4-N or sonnet-4.N where N >= 6.
  const opusMatch = modelId.match(/opus-4[.-](\d+)/);
  if (opusMatch && Number.parseInt(opusMatch[1], 10) >= 6) return true;
  const sonnetMatch = modelId.match(/sonnet-4[.-](\d+)/);
  if (sonnetMatch && Number.parseInt(sonnetMatch[1], 10) >= 6) return true;
  return false;
}

function mapThinkingLevelToEffort(
  level: ThinkingLevel,
  modelId: string,
): "low" | "medium" | "high" | "max" {
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      // "max" effort is only accepted by opus-4-N models.
      return /opus-4[.-]\d+/.test(modelId) ? "max" : "high";
    default:
      return "high";
  }
}

function rewritePayloadForAdaptiveThinking(
  payload: unknown,
  model: Model<"anthropic-messages">,
  effort: "low" | "medium" | "high" | "max",
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const params = payload as AnthropicRequestParamsWithThinking;
  const thinking = params.thinking as { type?: string; budget_tokens?: number } | undefined;
  // Only rewrite if pi-ai emitted budget-based thinking; leave adaptive/disabled/unset alone.
  if (!thinking || thinking.type !== "enabled") return payload;
  return {
    ...params,
    thinking: { type: "adaptive" },
    output_config: { effort },
  };
}

let patched = false;

export function installAnthropicAdaptiveThinkingPatch(): void {
  if (patched) return;
  patched = true;

  const original = getApiProvider(ADAPTIVE_API);
  if (!original) {
    // pi-ai lazy-registers built-ins at first import of stream.js; if the
    // registry is empty here it means import order went wrong and the patch
    // would silently do nothing.
    throw new Error(
      "installAnthropicAdaptiveThinkingPatch: 'anthropic-messages' provider not registered yet — " +
      "import @mariozechner/pi-ai's stream.js / registerBuiltInApiProviders before installing this patch.",
    );
  }

  registerApiProvider({
    api: ADAPTIVE_API,
    stream: original.stream,
    streamSimple: (
      model: Model<"anthropic-messages">,
      context: Context,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream => {
      if (!options?.reasoning || !needsAdaptiveOverride(model.id)) {
        return original.streamSimple(model, context, options);
      }
      const effort = mapThinkingLevelToEffort(options.reasoning, model.id);
      const upstreamOnPayload = options.onPayload;
      const rewritingOnPayload = async (payload: unknown, m: Model<"anthropic-messages">): Promise<unknown> => {
        // Rewrite first so any caller-supplied onPayload (e.g. debug logging)
        // observes the final over-the-wire payload, and caller edits run last.
        const rewritten = rewritePayloadForAdaptiveThinking(payload, m, effort);
        if (!upstreamOnPayload) return rewritten;
        const upstreamResult = await upstreamOnPayload(rewritten, m as Model<never>);
        return upstreamResult !== undefined ? upstreamResult : rewritten;
      };
      return original.streamSimple(model, context, {
        ...options,
        onPayload: rewritingOnPayload as SimpleStreamOptions["onPayload"],
      });
    },
  });
}
