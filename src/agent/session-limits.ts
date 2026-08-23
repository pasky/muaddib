import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { StopReason, Usage } from "@earendil-works/pi-ai";

import { isAssistantMessage } from "./message.js";
import type { Logger } from "../app/logging.js";

/** Usage slice of an assistant turn_end message that session limits care about. */
export interface TurnUsage extends Pick<Usage, "input" | "cacheRead" | "cacheWrite"> {
  cost: Pick<Usage["cost"], "total">;
}

/** Mutable timestamp holder — bumped externally when a response is delivered. */
export interface ResponseTimestamp {
  lastResponseAt: number;
}

/**
 * Session budget tracking: peak context length (input + cacheRead + cacheWrite
 * of any single turn) and cumulative cost against configurable ceilings.
 *
 * Owned by the session factory; consulted by the nudge policy below. When the
 * budget is exhausted the agent is first nudged (ephemerally) to wrap up, and
 * `recordTurn` arms a safety vent that requests a hard abort if the agent
 * keeps calling tools for 10 more turns past the limit.
 */
export class SessionLimits {
  private readonly initialMaxContextLength: number;
  private readonly initialMaxCostUsd: number;
  private maxContextLength: number;
  private maxCostUsd: number;
  private peakContextLength = 0;
  private cumulativeCost = 0;
  private turnsSinceSoftLimit = 0;

  constructor(maxContextLength: number, maxCostUsd: number) {
    this.initialMaxContextLength = maxContextLength;
    this.initialMaxCostUsd = maxCostUsd;
    this.maxContextLength = maxContextLength;
    this.maxCostUsd = maxCostUsd;
  }

  /** Either budget ceiling has been hit. */
  get reached(): boolean {
    return this.peakContextLength >= this.maxContextLength || this.cumulativeCost >= this.maxCostUsd;
  }

  /** Within 80% of either ceiling — used to suppress progress nudges. */
  get nearLimit(): boolean {
    return (
      this.peakContextLength >= this.maxContextLength * 0.8 ||
      this.cumulativeCost >= this.maxCostUsd * 0.8
    );
  }

  /**
   * Record an assistant turn's usage. Returns true when the safety vent has
   * tripped and the caller should abort the prompt loop.
   */
  recordTurn(usage: TurnUsage | undefined, stopReason: StopReason | undefined): boolean {
    if (usage) {
      const turnContext = usage.input + usage.cacheRead + usage.cacheWrite;
      this.peakContextLength = Math.max(this.peakContextLength, turnContext);
      this.cumulativeCost += usage.cost.total;
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
        parts.push("*If* you are going to call more tools, write also an extremely brief one-line status of what you are doing and why. If you are instead ready to answer, output ONLY the answer - no status line, no preamble, no restating your reply twice. Continue now.");
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
  invocationStartMessageCount: number,
  limits: SessionLimits,
  getNudgeText: (turnCount: number) => string | null,
  logger: Logger,
) {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    // Count assistant turns produced in this invocation (not from preloaded context).
    const invocationMessages = messages.slice(invocationStartMessageCount);
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
