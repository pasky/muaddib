import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { StopReason, Usage } from "@earendil-works/pi-ai";

import { isAssistantMessage } from "./message.js";
import type { Logger } from "../app/logging.js";
import { accumulateUsage, cloneUsage, emptyUsage } from "../cost/usage.js";

/** Mutable timestamp holder — bumped externally when a response is delivered. */
export interface ResponseTimestamp {
  lastResponseAt: number;
}

/**
 * Boundary between the preloaded context and this invocation's own turns,
 * held as the identity of the last preloaded message rather than as an index:
 * compaction rewrites the message list, and any index captured beforehand is
 * meaningless afterwards. A message that compaction summarized away is simply
 * no longer found, and everything left counts as invocation content.
 */
export interface InvocationStart {
  boundary: AgentMessage | null;
}

/**
 * Session budget tracking: billed usage accumulated from every LLM call of the
 * session (agent turns and compaction summarizations alike), with peak context
 * length (input + cacheRead + cacheWrite of any single call) and cumulative
 * cost checked against configurable ceilings.
 *
 * Owned by the session factory; consulted by the nudge policy below. When the
 * budget is exhausted the agent is first nudged (ephemerally) to wrap up, and
 * `recordTurn` arms a safety vent that requests a hard abort if the agent
 * keeps calling tools for 10 more turns past the limit.
 *
 * This is also the source of truth for what the session cost: compaction
 * truncates `session.messages` and its summarization call is never represented
 * there, so summing usage over surviving messages undercounts.
 */
export class SessionLimits {
  private readonly initialMaxContextLength: number;
  private readonly initialMaxCostUsd: number;
  private maxContextLength: number;
  private maxCostUsd: number;
  private readonly usage = emptyUsage();
  private peakContextLength = 0;
  private turnsSinceSoftLimit = 0;

  constructor(maxContextLength: number, maxCostUsd: number) {
    this.initialMaxContextLength = maxContextLength;
    this.initialMaxCostUsd = maxCostUsd;
    this.maxContextLength = maxContextLength;
    this.maxCostUsd = maxCostUsd;
  }

  /** Either budget ceiling has been hit. */
  get reached(): boolean {
    return this.peakContextLength >= this.maxContextLength || this.usage.cost.total >= this.maxCostUsd;
  }

  /** Within 80% of either ceiling — used to suppress progress nudges. */
  get nearLimit(): boolean {
    return (
      this.peakContextLength >= this.maxContextLength * 0.8 ||
      this.usage.cost.total >= this.maxCostUsd * 0.8
    );
  }

  /**
   * Snapshot of everything billed so far. A copy, not the live accumulator:
   * follow-up prompts on the same session (memory update, tool summary) keep
   * billing after a caller has taken its total.
   */
  usageSummary(): { usage: Usage; peakTurnInput: number } {
    return { usage: cloneUsage(this.usage), peakTurnInput: this.peakContextLength };
  }

  /**
   * Record an LLM call's usage. Pass the stop reason for assistant turns (it
   * drives the safety vent); leave it undefined for compaction summarizations.
   * Returns true when the safety vent has tripped and the caller should abort
   * the prompt loop.
   */
  recordTurn(usage: Usage | undefined, stopReason: StopReason | undefined): boolean {
    if (usage) {
      accumulateUsage(this.usage, usage);
      this.peakContextLength = Math.max(this.peakContextLength, usage.input + usage.cacheRead + usage.cacheWrite);
    }
    if (this.reached && stopReason === "toolUse") {
      this.turnsSinceSoftLimit += 1;
    }
    return this.reached && this.turnsSinceSoftLimit >= 10;
  }

  /**
   * Raise the ceilings mid-session (e.g. user-approved extension). Increments
   * are floored at 10% of the ORIGINAL configured limits so a tiny bump still
   * meaningfully unblocks the session. Re-arms the safety vent: the extended
   * budget grants a fresh 10-turn window if the new ceiling is reached again.
   */
  bump(tokens: number, costUsd: number): void {
    this.maxContextLength += Math.max(tokens, Math.ceil(this.initialMaxContextLength * 0.1));
    this.maxCostUsd += Math.max(costUsd, this.initialMaxCostUsd * 0.1);
    this.turnsSinceSoftLimit = 0;
  }
}

/**
 * Build a function that decides what nudge text (if any) to inject for a given
 * assistant turn count. Encapsulates all policy: metaReminder, progress
 * threshold, high-reasoning first-turn special case, and near-limit
 * suppression.
 */
export function createNudgeDecider(
  limits: SessionLimits,
  sessionStartTime: number,
  thinkingLevel: ThinkingLevel,
  responseTimestamp: ResponseTimestamp,
  metaReminder?: string,
  progressThresholdSeconds?: number,
): (turnCount: number) => string | null {
  return (turnCount: number): string | null => {
    const parts: string[] = [];

    if (metaReminder) {
      parts.push(metaReminder);
    }

    // Suppress progress nudges when within 80% of either limit.
    if (progressThresholdSeconds != null && !limits.nearLimit) {
      const now = Date.now();
      const lastActivity = Math.max(sessionStartTime, responseTimestamp.lastResponseAt);
      const elapsedSinceLastReport = (now - lastActivity) / 1000;
      const isFirstTurnHighReasoning =
        turnCount === 1 &&
        (thinkingLevel === "medium" || thinkingLevel === "high" || thinkingLevel === "xhigh" || thinkingLevel === "max");

      if (isFirstTurnHighReasoning || elapsedSinceLastReport >= progressThresholdSeconds) {
        parts.push("*If* you are going to call more tools, write also an extremely brief one-line status of what you are doing and why, wrapped in <status>...</status> tags (they are machine-readable: a status note is dropped instead of delivered when it turns out you are already answering). Never put your actual answer inside <status>. Continue now.");
      }
    }

    return parts.length > 0 ? parts.join(" ") : null;
  };
}

/**
 * Build a transformContext function that injects internal <meta> nudges
 * (and session-limit messages) ephemerally into the LLM context just before
 * each assistant call.  The injected message is visible to the LLM but never
 * persisted into agent.state.messages, so it cannot trigger extra turns.
 */
export function createInternalNudgeTransform(
  invocationStart: InvocationStart,
  limits: SessionLimits,
  getNudgeText: (turnCount: number) => string | null,
  logger: Logger,
) {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    // Count assistant turns produced in this invocation (not from preloaded context).
    const boundary = invocationStart.boundary ? messages.indexOf(invocationStart.boundary) : -1;
    const invocationMessages = boundary >= 0 ? messages.slice(boundary + 1) : messages;
    const turnCount = invocationMessages.filter(isAssistantMessage).length;

    // When session limit is reached, inject the limit message instead of
    // regular nudges.
    if (limits.reached) {
      const lastMsg = invocationMessages.at(-1) as { role?: string } | undefined;
      const lastIsToolResult = lastMsg?.role === "toolResult";
      if (!lastIsToolResult) return messages;

      logger.debug("session_limit_nudge_injected via transformContext");
      return [
        ...messages,
        {
          role: "user",
          content: [{ type: "text", text: "<meta>You have reached your session limit - time to provide your final text response.</meta>" }],
          timestamp: Date.now(),
        } as AgentMessage,
      ];
    }

    const isFirstTurn = turnCount === 0;
    const lastMsg = invocationMessages.at(-1) as { role?: string; stopReason?: string } | undefined;
    const lastIsToolResult = lastMsg?.role === "toolResult";
    // The most recent assistant message (immediately before the toolResult block)
    const lastAssistant = [...invocationMessages].reverse().find(isAssistantMessage);
    const lastStopReason = lastAssistant?.stopReason;
    const isAfterToolUse = lastIsToolResult && lastStopReason === "toolUse";

    if (!isFirstTurn && !isAfterToolUse) {
      return messages;
    }

    const nudgeContent = getNudgeText(turnCount);
    if (nudgeContent === null) {
      return messages;
    }

    const nudgeText = `<meta>${nudgeContent}</meta>`;
    logger.debug(
      `internal_nudge_injected turnCount=${turnCount} isFirstTurn=${isFirstTurn} lastStopReason=${lastStopReason}`,
    );

    return [
      ...messages,
      {
        role: "user",
        content: [{ type: "text", text: nudgeText }],
        timestamp: Date.now(),
      } as AgentMessage,
    ];
  };
}
