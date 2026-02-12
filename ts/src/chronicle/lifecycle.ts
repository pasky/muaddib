import {
  completeSimple,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type UserMessage,
} from "@mariozechner/pi-ai";

import { PiAiModelAdapter } from "../models/pi-ai-model-adapter.js";
import {
  ChronicleStore,
  type Chapter,
} from "./chronicle-store.js";

type CompleteSimpleFn = (
  model: Model<any>,
  context: { messages: UserMessage[]; systemPrompt?: string },
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface ChronicleLifecycleConfig {
  model: string;
  arc_models?: Record<string, string>;
  paragraphs_per_chapter?: number;
}

export interface ChronicleLifecycle {
  appendParagraph(arc: string, text: string): Promise<{ id: number; chapter_id: number; ts: string; content: string }>;
}

export interface ChronicleLifecycleTsOptions {
  chronicleStore: ChronicleStore;
  config: ChronicleLifecycleConfig;
  modelAdapter?: PiAiModelAdapter;
  completeFn?: CompleteSimpleFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
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
  private readonly completeFn: CompleteSimpleFn;
  private readonly arcQueues = new Map<string, Promise<void>>();

  constructor(options: ChronicleLifecycleTsOptions) {
    this.chronicleStore = options.chronicleStore;
    this.config = options.config;
    this.modelAdapter = options.modelAdapter ?? new PiAiModelAdapter();
    this.completeFn = options.completeFn ?? completeSimple;
    this.getApiKey = async (provider: string) => {
      if (!options.getApiKey) {
        return undefined;
      }
      return await options.getApiKey(provider);
    };
  }

  private readonly getApiKey: (provider: string) => Promise<string | undefined>;

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
      return await this.chronicleStore.appendParagraph(arc, trimmed);
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
  }

  private async generateChapterSummary(arc: string, chapterParagraphs: string[]): Promise<string> {
    const modelSpec = this.resolveSummaryModelSpec(arc);
    const resolvedModel = this.modelAdapter.resolve(modelSpec).model;

    const response = await this.completeFn(
      resolvedModel,
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
        apiKey: await this.getApiKey(resolvedModel.provider),
        maxTokens: 1024,
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
    const parsed = Number(this.config.paragraphs_per_chapter);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_PARAGRAPHS_PER_CHAPTER;
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
