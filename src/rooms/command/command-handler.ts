/**
 * Command handler — session lifecycle coordinator.
 *
 * Owns the steering queue and dispatch between command/passive message paths.
 * Delegates command execution to CommandExecutor and proactive interjection
 * lifecycle to ProactiveRunner.
 */

import {
  SteeringQueue,
  type SteeringKey,
} from "./steering-queue.js";
import { CommandResolver } from "./resolver.js";
import { buildProactiveConfig, ProactiveRunner } from "./proactive.js";
import {
  CommandExecutor,
  type CommandExecutionResult,
  type SteeringContextDrainer,
  type CommandExecutorOverrides,
  type CommandExecutorLogger,
} from "./command-executor.js";
import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import type { RoomMessage } from "../message.js";
import type { MuaddibRuntime } from "../../runtime.js";

// Re-export types that external consumers depend on
export type {
  CommandExecutionResult,
  CommandRunnerFactory,
  CommandRunnerFactoryInput,
  CommandRateLimiter,
  CommandExecutorLogger as CommandHandlerLogger,
  SteeringContextDrainer,
  CommandRunner,
  CommandExecutorOverrides,
} from "./command-executor.js";

export { CommandExecutor } from "./command-executor.js";

export type RoomCommandHandlerOverrides = CommandExecutorOverrides;

export interface HandleIncomingMessageOptions {
  isDirect: boolean;
  sendResponse?: (text: string) => Promise<void>;
}

/**
 * Shared TS command execution path with proactive interjection support.
 *
 * Proactive interjection is integrated into the steering queue: passive messages
 * in proactive-enabled channels start a steering session with a debounce-until-
 * silence loop.  Commands arriving during the debounce or during agent execution
 * are handled via the normal steering mechanism (queued and drained mid-flight).
 */
export class RoomCommandHandlerTs {
  readonly resolver: CommandResolver;
  private readonly executor: CommandExecutor;
  private readonly steeringQueue: SteeringQueue;
  private readonly proactiveRunner: ProactiveRunner | null;
  private readonly history: ChatHistoryStore;
  private readonly logger: CommandExecutorLogger;

  constructor(
    runtime: MuaddibRuntime,
    roomName: string,
    overrides?: RoomCommandHandlerOverrides,
  ) {
    this.executor = new CommandExecutor(runtime, roomName, overrides);
    this.resolver = this.executor.resolver;
    this.steeringQueue = new SteeringQueue();
    this.history = runtime.history;
    this.logger = runtime.logger.getLogger(`muaddib.rooms.command.${roomName}`);

    // Proactive interjection setup
    const roomConfig = runtime.config.getRoomConfig(roomName);
    const proactiveConfig = buildProactiveConfig(roomConfig.proactive, this.executor.commandConfig);

    if (proactiveConfig) {
      this.proactiveRunner = new ProactiveRunner({
        config: proactiveConfig,
        history: runtime.history,
        modelAdapter: runtime.modelAdapter,
        getApiKey: runtime.getApiKey,
        classifyMode: this.executor.classifyMode,
        logger: this.logger,
        executor: this.executor,
        resolver: this.resolver,
        steeringQueue: this.steeringQueue,
      });
    } else {
      this.proactiveRunner = null;
    }
  }

  shouldIgnoreUser(nick: string): boolean {
    const ignoreUsers = this.executor.commandConfig.ignore_users ?? [];
    return ignoreUsers.some((ignored) => String(ignored).toLowerCase() === nick.toLowerCase());
  }

  async handleIncomingMessage(
    message: RoomMessage,
    options: HandleIncomingMessageOptions,
  ): Promise<CommandExecutionResult | null> {
    const triggerMessageId = await this.history.addMessage(message);

    if (!options.isDirect) {
      this.logger.debug(
        "Handling passive message",
        `arc=${message.serverTag}#${message.channelName}`,
        `nick=${message.nick}`,
      );
      await this.handlePassiveMessage(message, options.sendResponse);
      return null;
    }

    this.logger.debug(
      "Handling direct command",
      `arc=${message.serverTag}#${message.channelName}`,
      `nick=${message.nick}`,
    );

    if (this.resolver.shouldBypassSteeringQueue(message)) {
      return this.executor.execute(
        message,
        triggerMessageId,
        options.sendResponse,
        this.createSteeringContextDrainer(SteeringQueue.keyForMessage(message)),
      );
    }

    return this.handleCommandMessage(message, triggerMessageId, options.sendResponse);
  }

  /** Direct execution without steering queue (for CLI / tests). */
  async execute(message: RoomMessage): Promise<CommandExecutionResult> {
    return this.executor.execute(
      message,
      0,
      undefined,
      this.createSteeringContextDrainer(SteeringQueue.keyForMessage(message)),
    );
  }

  /** Expose buildSystemPrompt for tests. */
  buildSystemPrompt(mode: string, mynick: string, modelOverride?: string): string {
    return this.executor.buildSystemPrompt(mode, mynick, modelOverride);
  }

  // ── Session lifecycle: commands ──

  private async handleCommandMessage(
    message: RoomMessage,
    triggerMessageId: number,
    sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<CommandExecutionResult | null> {
    const {
      isRunner,
      steeringKey,
      item: runnerItem,
    } = this.steeringQueue.enqueueCommandOrStartRunner(message, triggerMessageId, sendResponse);

    if (!isRunner) {
      await runnerItem.completion;
      return (runnerItem.result as CommandExecutionResult | null) ?? null;
    }

    try {
      if (runnerItem.triggerMessageId === null) {
        throw new Error("Runner command item is missing trigger message id.");
      }

      runnerItem.result = await this.executor.execute(
        runnerItem.message,
        runnerItem.triggerMessageId,
        runnerItem.sendResponse,
        this.createSteeringContextDrainer(steeringKey),
      );

      this.steeringQueue.finishItem(runnerItem);
      await this.drainRemainingSessionItems(steeringKey);
    } catch (error) {
      this.steeringQueue.abortSession(steeringKey, error);
      this.steeringQueue.failItem(runnerItem, error);
      throw error;
    }

    return (runnerItem.result as CommandExecutionResult | null) ?? null;
  }

  // ── Session lifecycle: passives ──

  private async handlePassiveMessage(
    message: RoomMessage,
    sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<void> {
    const channelKey = CommandResolver.channelKey(message.serverTag, message.channelName);
    const startProactive = this.proactiveRunner?.isProactiveChannel(channelKey) ?? false;

    const { queued, isProactiveRunner, steeringKey, item } =
      this.steeringQueue.enqueuePassive(message, sendResponse, startProactive);

    if (queued) {
      await item.completion;
      return;
    }

    if (isProactiveRunner && this.proactiveRunner) {
      this.proactiveRunner.runSession(
        steeringKey,
        item,
        (key) => this.createSteeringContextDrainer(key),
      ).catch((error) => {
        this.logger.error("Proactive session failed", error);
      });
      await item.completion;
      return;
    }

    await this.handlePassiveMessageCore(message, sendResponse);
  }

  private async handlePassiveMessageCore(
    message: RoomMessage,
    _sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<void> {
    await this.executor.triggerAutoChronicler(message, this.executor.commandConfig.history_size);
  }

  // ── Shared session drain loop ──

  private async drainRemainingSessionItems(steeringKey: SteeringKey): Promise<void> {
    while (true) {
      const { dropped, nextItem } = this.steeringQueue.takeNextWorkCompacted(steeringKey);
      for (const droppedItem of dropped) {
        droppedItem.result = null;
        this.steeringQueue.finishItem(droppedItem);
      }

      if (!nextItem) {
        return;
      }

      if (nextItem.kind === "command") {
        if (nextItem.triggerMessageId === null) {
          throw new Error("Queued command item is missing trigger message id.");
        }
        nextItem.result = await this.executor.execute(
          nextItem.message,
          nextItem.triggerMessageId,
          nextItem.sendResponse,
          this.createSteeringContextDrainer(steeringKey),
        );
      } else {
        await this.handlePassiveMessageCore(nextItem.message, nextItem.sendResponse);
        nextItem.result = null;
      }

      this.steeringQueue.finishItem(nextItem);
    }
  }

  // ── Helpers ──

  private createSteeringContextDrainer(steeringKey: SteeringKey): SteeringContextDrainer {
    return () =>
      this.steeringQueue.drainSteeringContextMessages(steeringKey).map((msg) => ({
        role: "user",
        content: msg.content,
      }));
  }
}
