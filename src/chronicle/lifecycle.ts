
import type { Logger } from "../app/logging.js";
import { PiAiModelAdapter } from "../models/pi-ai-model-adapter.js";
import {
  ChronicleStore,
  type Chapter,
} from "./chronicle-store.js";
import { QUEST_OPEN_RE, QUEST_FINISHED_RE } from "./quest-runtime.js";

export interface ChronicleLifecycleConfig {
  model: string;
  arc_models?: Record<string, string>;
  paragraphs_per_chapter?: number;
}

export interface ChronicleLifecycle {
  appendParagraph(arc: string, text: string): Promise<{ id: number; chapter_id: number; ts: string; content: string }>;
}

interface ChronicleQuestRuntimeHook {
  onChronicleAppend(arc: string, paragraphText: string, paragraphId: number): Promise<void>;
}

export interface ChronicleLifecycleTsOptions {
  chronicleStore: ChronicleStore;
  config: ChronicleLifecycleConfig;
  modelAdapter: PiAiModelAdapter;
  questRuntime?: ChronicleQuestRuntimeHook;
  logger: Logger;
}

const DEFAULT_PARAGRAPHS_PER_CHAPTER = 3;

const CHAPTER_SUMMARY_PROMPT = `As an AI agent, you maintain a Chronicle (arcs → chapters → paragraphs) of your experiences, plans, thoughts and observations, forming the backbone of your consciousness.

Summarize the following chronicle chapter in a single paragraph.
Focus on the key events, decisions, and developments that happened.
Keep it concise but informative, as this will serve as a recap for the next chapter.

Respond only with the summary, no preamble.`;

export class ChronicleLifecycleTs implements ChronicleLifecycle {
  private readonly chronicleStore: ChronicleStore;
  private readonly config: ChronicleLifecycleConfig;
  private readonly modelAdapter: PiAiModelAdapter;
  private readonly questRuntime: ChronicleQuestRuntimeHook | null;
  private readonly logger: Logger;
  private readonly arcQueues = new Map<string, Promise<void>>();

  constructor(options: ChronicleLifecycleTsOptions) {
    this.chronicleStore = options.chronicleStore;
    this.config = options.config;
    this.modelAdapter = options.modelAdapter;
    this.questRuntime = options.questRuntime ?? null;
    this.logger = options.logger;
  }

  async appendParagraph(
    arc: string,
    text: string,
  ): Promise<{ id: number; chapter_id: number; ts: string; content: string }> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("paragraph_text must be non-empty");
    }

    return await this.withArcLock(arc, async () => {
      const currentChapter = await this.chronicleStore.getOrOpenCurrentChapter(arc);
      await this.rollChapterIfNeeded(arc, currentChapter);
      const appended = await this.chronicleStore.appendParagraph(arc, trimmed);

      if (this.questRuntime) {
        await this.questRuntime.onChronicleAppend(arc, trimmed, appended.id);
      }

      return appended;
    });
  }

  private async rollChapterIfNeeded(arc: string, currentChapter: Chapter): Promise<void> {
    const paragraphCount = await this.chronicleStore.countParagraphsInChapter(currentChapter.id);
    const maxParagraphs = this.resolveParagraphLimit();

    if (paragraphCount < maxParagraphs) {
      return;
    }

    const chapterParagraphs = await this.chronicleStore.readChapter(currentChapter.id);
    if (chapterParagraphs.length === 0) {
      throw new Error(`Chapter ${currentChapter.id} should have paragraphs but found none.`);
    }

    const summary = await this.generateChapterSummary(arc, chapterParagraphs);
    await this.chronicleStore.closeChapterWithSummary(currentChapter.id, summary);

    await this.chronicleStore.getOrOpenCurrentChapter(arc);
    await this.chronicleStore.appendParagraph(arc, `Previous chapter recap: ${summary}`);

    const unresolvedQuestParagraphs = this.collectUnresolvedQuestParagraphs(chapterParagraphs);
    for (const questParagraph of unresolvedQuestParagraphs) {
      await this.chronicleStore.appendParagraph(arc, questParagraph);
    }
  }

  private collectUnresolvedQuestParagraphs(chapterParagraphs: string[]): string[] {
    const latestByQuestId = new Map<string, { paragraph: string; isFinished: boolean }>();

    for (const paragraph of chapterParagraphs) {
      const finishedMatch = QUEST_FINISHED_RE.exec(paragraph);
      if (finishedMatch) {
        latestByQuestId.set(finishedMatch[1], {
          paragraph,
          isFinished: true,
        });
        continue;
      }

      const questMatch = QUEST_OPEN_RE.exec(paragraph);
      if (questMatch) {
        latestByQuestId.set(questMatch[1], {
          paragraph,
          isFinished: false,
        });
      }
    }

    const unresolved: string[] = [];
    for (const entry of latestByQuestId.values()) {
      if (!entry.isFinished) {
        unresolved.push(entry.paragraph);
      }
    }

    return unresolved;
  }

  private async generateChapterSummary(arc: string, chapterParagraphs: string[]): Promise<string> {
    const modelSpec = this.resolveSummaryModelSpec(arc);

    const response = await this.modelAdapter.completeSimple(
      modelSpec,
      {
        systemPrompt: CHAPTER_SUMMARY_PROMPT,
        messages: [
          {
            role: "user",
            content: chapterParagraphs.join("\n\n"),
            timestamp: Date.now(),
          },
        ],
      },
      {
        callType: "chronicler_summary",
        logger: this.logger,
        streamOptions: {
          maxTokens: 1024,
        },
      },
    );

    const summary = response.content
      .filter((entry) => entry.type === "text")
      .map((entry) => entry.text)
      .join("\n")
      .trim();

    if (!summary) {
      throw new Error("Chronicler chapter summary model returned empty response.");
    }

    return summary;
  }

  private resolveSummaryModelSpec(arc: string): string {
    return this.config.arc_models?.[arc] ?? this.config.model;
  }

  private resolveParagraphLimit(): number {
    if (this.config.paragraphs_per_chapter == null) {
      return DEFAULT_PARAGRAPHS_PER_CHAPTER;
    }

    const parsed = Number(this.config.paragraphs_per_chapter);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid paragraphs_per_chapter: ${this.config.paragraphs_per_chapter}`);
    }

    return Math.trunc(parsed);
  }

  private async withArcLock<T>(arc: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.arcQueues.get(arc) ?? Promise.resolve();

    let release: (() => void) | undefined;
    const signal = new Promise<void>((resolve) => {
      release = resolve;
    });

    const queued = previous.then(async () => await signal);
    this.arcQueues.set(arc, queued);

    await previous;

    try {
      return await fn();
    } finally {
      release?.();
      if (this.arcQueues.get(arc) === queued) {
        this.arcQueues.delete(arc);
      }
    }
  }
}
