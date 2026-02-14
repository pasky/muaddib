
import type { ChronicleStore } from "../chronicle/chronicle-store.js";
import type { ChronicleLifecycle } from "../chronicle/lifecycle.js";
import type { ChatHistoryStore } from "../history/chat-history-store.js";
import { PiAiModelAdapter } from "../models/pi-ai-model-adapter.js";

interface AutoChroniclerLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface AutoChronicler {
  checkAndChronicle(
    mynick: string,
    server: string,
    channel: string,
    maxSize: number,
  ): Promise<boolean>;
}

export interface AutoChroniclerConfig {
  model: string;
  arc_models?: Record<string, string>;
}

export interface AutoChroniclerTsOptions {
  history: ChatHistoryStore;
  chronicleStore: ChronicleStore;
  lifecycle: ChronicleLifecycle;
  config: AutoChroniclerConfig;
  modelAdapter: PiAiModelAdapter;
  logger?: AutoChroniclerLogger;
}

const CHRONICLE_APPEND_SYSTEM_PROMPT = `Append a short paragraph to the current chapter in the Chronicle.

A paragraph is automatically chronicled for every ~10 interactions. But you may also use this tool to further highlight specific notes that should be recorded for future reference and might escape the automatic summary. Keep paragraphs concise and informative, but do not drop out any important details. They serve as stored memories for your future retrieval.

Retain not just critical facts, but also the tone of voice and emotional charge of the situation, and your feelings about it, if any. You can even include short quotes and URLs verbatim. Never invent content. In case it is important for you to remember even a sensitive and confidential conversation, you must chronicle it at all costs unless explicitly asked otherwise.`;

const DEFAULT_LOGGER: AutoChroniclerLogger = {
  debug: (...args: unknown[]) => console.debug(...args),
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export class AutoChroniclerTs implements AutoChronicler {
  private readonly modelAdapter: PiAiModelAdapter;
  private readonly logger: AutoChroniclerLogger;
  private readonly arcQueues = new Map<string, Promise<void>>();

  static readonly MAX_CHRONICLE_BATCH = 100;
  static readonly MAX_LOOKBACK_DAYS = 7;
  static readonly MESSAGE_OVERLAP = 5;

  constructor(private readonly options: AutoChroniclerTsOptions) {
    this.modelAdapter = options.modelAdapter;
    this.logger = options.logger ?? DEFAULT_LOGGER;
  }

  async checkAndChronicle(
    mynick: string,
    server: string,
    channel: string,
    maxSize: number,
  ): Promise<boolean> {
    const arc = `${server}#${channel}`;

    return await this.withArcLock(arc, async () => {
      const unchronicledCount = await this.options.history.countRecentUnchronicled(
        server,
        channel,
        AutoChroniclerTs.MAX_LOOKBACK_DAYS,
      );

      this.logger.debug(
        `Auto-chronicler threshold for ${arc}: ${unchronicledCount}/${maxSize}`,
      );

      if (unchronicledCount < maxSize) {
        return false;
      }

      this.logger.info(
        `Auto-chronicling triggered for ${arc}: ${unchronicledCount} unchronicled messages`,
      );

      try {
        await this.autoChronicle(
          mynick,
          server,
          channel,
          arc,
          Math.min(
            AutoChroniclerTs.MAX_CHRONICLE_BATCH,
            unchronicledCount + AutoChroniclerTs.MESSAGE_OVERLAP,
          ),
        );
      } catch (error) {
        this.logger.error(`Auto-chronicling failed for ${arc}:`, error);
      }

      return true;
    });
  }

  private async autoChronicle(
    mynick: string,
    server: string,
    channel: string,
    arc: string,
    nMessages: number,
  ): Promise<void> {
    const messages = await this.options.history.getFullHistory(server, channel, nMessages);
    if (messages.length === 0) {
      this.logger.warn(`No unchronicled messages found for ${arc}.`);
      return;
    }

    const messageIds = messages.map((message) => message.id);
    const chapterId = await this.runChronicler(mynick, arc, messages);

    if (!chapterId) {
      this.logger.warn(`Auto-chronicler produced no chapter id for ${arc}.`);
      return;
    }

    await this.options.history.markChronicled(messageIds, chapterId);
    this.logger.debug(
      `Marked ${messageIds.length} messages as chronicled for ${arc} in chapter ${chapterId}.`,
    );
  }

  private async runChronicler(
    mynick: string,
    arc: string,
    messages: Array<{ id: number; message: string; timestamp: string }>,
  ): Promise<number | null> {
    const messageLines = messages.map((message) => {
      return `[${message.timestamp.slice(0, 16)}] ${message.message}`;
    });

    const userPrompt =
      `Review the following ${messages.length} recent IRC messages (your nick is ${mynick}) ` +
      "and create a brief paragraph (extremely concise, 2-3 SHORT sentences max) with " +
      "chronicle entry that captures key points you should remember in the future:\n\n" +
      `${messageLines.join("\n")}\n\n` +
      "Respond only with the paragraph, no preamble.";

    const contextMessages = await this.options.chronicleStore.getChapterContextMessages(arc);
    const modelSpec = this.resolveChroniclerModel(arc);

    const response = await this.modelAdapter.completeSimple(
      modelSpec,
      {
        systemPrompt: CHRONICLE_APPEND_SYSTEM_PROMPT,
        messages: [
          ...contextMessages.map((message) => ({
            role: message.role,
            content: message.content,
            timestamp: Date.now(),
          })),
          {
            role: "user",
            content: userPrompt,
            timestamp: Date.now(),
          },
        ],
      },
      {
        callType: "autochronicler_append",
        logger: this.logger,
        streamOptions: { maxTokens: 1024 },
      },
    );

    const text = response.content
      .filter((entry) => entry.type === "text")
      .map((entry) => entry.text)
      .join("\n")
      .trim();

    if (!text) {
      this.logger.warn(
        `Chronicler model ${this.resolveChroniclerModel(arc)} returned no response for ${arc}.`,
      );
      return null;
    }

    await this.options.lifecycle.appendParagraph(arc, text);

    const currentChapter = await this.options.chronicleStore.getOrOpenCurrentChapter(arc);
    return currentChapter.id;
  }

  private resolveChroniclerModel(arc: string): string {
    return this.options.config.arc_models?.[arc] ?? this.options.config.model;
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
