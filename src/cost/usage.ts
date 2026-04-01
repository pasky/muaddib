import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Usage } from "@mariozechner/pi-ai";

import { isAssistantMessage } from "../agent/message.js";

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

/** Mutates target by accumulating source into it, then returns target. */
export function accumulateUsage(target: Usage, source: Usage): Usage {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.cost.input += source.cost.input;
  target.cost.output += source.cost.output;
  target.cost.cacheRead += source.cost.cacheRead;
  target.cost.cacheWrite += source.cost.cacheWrite;
  target.cost.total += source.cost.total;
  return target;
}

export function cloneUsage(source: Usage): Usage {
  return accumulateUsage(emptyUsage(), source);
}

export function sumAssistantUsage(messages: readonly AgentMessage[]): { usage: Usage; peakTurnInput: number } {
  const total = emptyUsage();
  let peakTurnInput = 0;

  for (const message of messages) {
    if (!isAssistantMessage(message)) {
      continue;
    }

    const usage = message.usage;
    accumulateUsage(total, usage);

    const turnInput = usage.input + usage.cacheRead + usage.cacheWrite;
    if (turnInput > peakTurnInput) {
      peakTurnInput = turnInput;
    }
  }

  return { usage: total, peakTurnInput };
}
