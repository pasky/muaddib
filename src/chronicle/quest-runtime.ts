import { CONSOLE_LOGGER, type Logger } from "../app/logging.js";
import type { ChronicleStore, QuestRow } from "./chronicle-store.js";
import { sleep } from "../utils/index.js";

const QUEST_OPEN_RE = /<\s*quest\s+id="([^"]+)"\s*>/i;
const QUEST_FINISHED_RE = /<\s*quest_finished\s+id="([^"]+)"\s*>/i;


export interface QuestStepInput {
  arc: string;
  questId: string;
  lastState: string;
}

export interface QuestStepResult {
  paragraphText: string;
}

export type QuestStepRunner = (input: QuestStepInput) => Promise<QuestStepResult | null>;

export interface QuestRuntimeConfig {
  arcs?: string[];
  cooldownSeconds: number;
}

export interface QuestRuntimeTsOptions {
  chronicleStore: ChronicleStore;
  appendParagraph: (arc: string, text: string) => Promise<unknown>;
  config: QuestRuntimeConfig;
  runQuestStep?: QuestStepRunner;
  logger?: Logger;
}

/**
 * Quest lifecycle runtime for chronicle paragraph hooks + heartbeat scheduling.
 *
 * This mirrors Python quest-state semantics while keeping execution strategy injectable.
 */
export class QuestRuntimeTs {
  private readonly logger: Logger;
  private readonly chronicleStore: ChronicleStore;
  private readonly appendParagraph: (arc: string, text: string) => Promise<unknown>;
  private readonly cooldownSeconds: number;
  private readonly runQuestStep: QuestStepRunner;
  private readonly allowedArcs: Set<string>;
  private readonly inFlightSteps = new Set<Promise<void>>();

  private heartbeatPromise: Promise<void> | null = null;
  private heartbeatStopRequested = false;

  constructor(options: QuestRuntimeTsOptions) {
    this.logger = options.logger ?? CONSOLE_LOGGER;
    this.chronicleStore = options.chronicleStore;
    this.appendParagraph = options.appendParagraph;
    this.cooldownSeconds = resolveCooldownSeconds(options.config.cooldownSeconds);
    this.allowedArcs = new Set(options.config.arcs ?? []);
    this.runQuestStep =
      options.runQuestStep ??
      (async () => {
        return null;
      });
  }

  async onChronicleAppend(arc: string, paragraphText: string, paragraphId: number): Promise<void> {
    const parsed = parseQuestParagraph(paragraphText);
    if (!parsed) {
      return;
    }

    if (!this.isArcAllowed(arc)) {
      this.logger.debug(`Quest ${parsed.questId} ignored for arc '${arc}' (not in allowlist).`);
      return;
    }

    const existing = await this.chronicleStore.questGet(parsed.questId);
    if (existing) {
      if (parsed.isFinished) {
        await this.chronicleStore.questFinish(parsed.questId, paragraphId);
      } else {
        await this.chronicleStore.questUpdate(parsed.questId, paragraphText, paragraphId);
      }
      return;
    }

    if (parsed.isFinished) {
      this.logger.warn(`Quest '${parsed.questId}' finished tag ignored because the quest does not exist.`);
      return;
    }

    await this.chronicleStore.questStart(
      parsed.questId,
      arc,
      paragraphId,
      paragraphText,
      extractParentQuestId(parsed.questId),
    );
  }

  async startHeartbeat(): Promise<void> {
    if (this.heartbeatPromise) {
      return;
    }

    this.heartbeatStopRequested = false;
    this.heartbeatPromise = this.heartbeatLoop();
  }

  async stopHeartbeat(): Promise<void> {
    this.heartbeatStopRequested = true;

    const heartbeat = this.heartbeatPromise;
    if (heartbeat) {
      await heartbeat;
      this.heartbeatPromise = null;
    }

    if (this.inFlightSteps.size > 0) {
      await Promise.allSettled([...this.inFlightSteps]);
    }
  }

  async heartbeatTick(): Promise<void> {
    if (this.allowedArcs.size === 0) {
      return;
    }

    for (const arc of this.allowedArcs) {
      const ready = await this.chronicleStore.questsReadyForHeartbeat(arc, this.cooldownSeconds);
      for (const quest of ready) {
        this.spawnQuestStep(arc, quest);
      }
    }
  }

  private async heartbeatLoop(): Promise<void> {
    while (!this.heartbeatStopRequested) {
      await sleep(this.cooldownSeconds * 1000);
      if (this.heartbeatStopRequested) {
        break;
      }

      try {
        await this.heartbeatTick();
      } catch (error) {
        this.logger.error("Quest heartbeat tick failed:", error);
      }
    }
  }

  private spawnQuestStep(arc: string, quest: QuestRow): void {
    const task = this.runQuestStepLocked(arc, quest)
      .catch((error) => {
        this.logger.error(`Quest step failed for ${quest.id}:`, error);
      })
      .finally(() => {
        this.inFlightSteps.delete(task);
      });

    this.inFlightSteps.add(task);
  }

  private async runQuestStepLocked(arc: string, quest: QuestRow): Promise<void> {
    const claimed = await this.chronicleStore.questTryTransition(quest.id, "ongoing", "in_step");
    if (!claimed) {
      return;
    }

    try {
      const stepResult = await this.runQuestStep({
        arc,
        questId: quest.id,
        lastState: quest.last_state ?? "",
      });

      const paragraphText = stepResult?.paragraphText?.trim();
      if (paragraphText) {
        await this.appendParagraph(arc, paragraphText);
      }
    } finally {
      await this.chronicleStore.questTryTransition(quest.id, "in_step", "ongoing");
    }
  }

  private isArcAllowed(arc: string): boolean {
    if (this.allowedArcs.size === 0) {
      return true;
    }

    return this.allowedArcs.has(arc);
  }
}

function parseQuestParagraph(text: string): { questId: string; isFinished: boolean } | null {
  const finishedMatch = QUEST_FINISHED_RE.exec(text);
  if (finishedMatch) {
    return {
      questId: finishedMatch[1],
      isFinished: true,
    };
  }

  const openMatch = QUEST_OPEN_RE.exec(text);
  if (openMatch) {
    return {
      questId: openMatch[1],
      isFinished: false,
    };
  }

  return null;
}

function extractParentQuestId(questId: string): string | null {
  if (!questId.includes(".")) {
    return null;
  }

  return questId.slice(0, questId.lastIndexOf(".")) || null;
}

function resolveCooldownSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 60;
  }

  return value;
}
