
import type { Logger } from "../app/logging.js";
import { PiAiModelAdapter } from "../models/pi-ai-model-adapter.js";
import { responseText } from "../agent/message.js";
import { ArcLockManager } from "../utils/arc-lock.js";
import {
  ChronicleStore,
  type Chapter,
} from "./chronicle-store.js";
import { withCostSpan } from "../cost/cost-span.js";
import { LLM_CALL_TYPE } from "../cost/llm-call-type.js";

export interface ChronicleLifecycleConfig {
  model: string;
  arcModels?: Record<string, string>;
  paragraphsPerChapter?: number;
}

export interface ChronicleLifecycle {
  appendParagraph(arc: string, text: string): Promise<{ chapter_number: number; ts: string; content: string }>;
}

export interface ChronicleLifecycleTsOptions {
  chronicleStore: ChronicleStore;
  config: ChronicleLifecycleConfig;
  modelAdapter: PiAiModelAdapter;
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
  private readonly logger: Logger;
  private readonly arcLock = new ArcLockManager();

  constructor(options: ChronicleLifecycleTsOptions) {
    this.chronicleStore = options.chronicleStore;
    this.config = options.config;
    this.modelAdapter = options.modelAdapter;
    this.logger = options.logger;
  }

  async appendParagraph(
    arc: string,
    text: string,
  ): Promise<{ chapter_number: number; ts: string; content: string }> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("paragraph_text must be non-empty");
    }

    return await this.arcLock.run(arc, async () => {
      const currentChapter = await this.chronicleStore.getOrOpenCurrentChapter(arc);
      await this.rollChapterIfNeeded(arc, currentChapter);
      const appended = await this.chronicleStore.appendParagraph(arc, trimmed);

      return appended;
    });
  }

  private async rollChapterIfNeeded(arc: string, currentChapter: Chapter): Promise<void> {
    const paragraphCount = await this.chronicleStore.countParagraphsInChapter(currentChapter.number, arc);
    const maxParagraphs = this.resolveParagraphLimit();

    if (paragraphCount < maxParagraphs) {
      return;
    }

    const chapterParagraphs = await this.chronicleStore.readChapter(currentChapter.number, arc);
    if (chapterParagraphs.length === 0) {
      throw new Error(`Chapter ${currentChapter.number} should have paragraphs but found none.`);
    }

    const summary = await this.generateChapterSummary(arc, chapterParagraphs);
    await this.chronicleStore.closeChapterWithSummary(currentChapter.number, arc, summary);

    await this.chronicleStore.getOrOpenCurrentChapter(arc);
    await this.chronicleStore.appendParagraph(arc, `Previous chapter recap: ${summary}`);
  }

  private async generateChapterSummary(arc: string, chapterParagraphs: string[]): Promise<string> {
    return await withCostSpan(LLM_CALL_TYPE.CHAPTER_SUMMARY, { arc }, async () => {
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
          callType: LLM_CALL_TYPE.CHAPTER_SUMMARY,
          logger: this.logger,
          streamOptions: {
            maxTokens: 1024,
          },
        },
      );

      const summary = responseText(response);

      if (!summary) {
        throw new Error("Chronicler chapter summary model returned empty response.");
      }

      return summary;
    });
  }

  private resolveSummaryModelSpec(arc: string): string {
    return this.config.arcModels?.[arc] ?? this.config.model;
  }

  private resolveParagraphLimit(): number {
    if (this.config.paragraphsPerChapter == null) {
      return DEFAULT_PARAGRAPHS_PER_CHAPTER;
    }

    const parsed = Number(this.config.paragraphsPerChapter);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid paragraphsPerChapter: ${this.config.paragraphsPerChapter}`);
    }

    return Math.trunc(parsed);
  }

}
