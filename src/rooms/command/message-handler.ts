/**
 * Room message handler — session lifecycle coordinator.
 *
 * Owns the steering queue and dispatch between direct command vs passive message paths.
 * Delegates execution to CommandExecutor and proactive interjection lifecycle to ProactiveRunner.
 */

import { SteeringQueue } from "./steering-queue.js";
import { CommandResolver } from "./resolver.js";
import { buildProactiveConfig, ProactiveRunner } from "./proactive.js";
import {
  CommandExecutor,
  type CommandExecutionResult,
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
  CommandExecutorOverrides,
} from "./command-executor.js";

/**
 * Shared room message handling path with proactive interjection support.
 *
 * Proactive interjection is integrated into the steering queue: passive messages
 * in proactive-enabled channels start a steering session with a debounce-until-
 * silence loop. Commands arriving during the debounce or during agent execution
 * are handled via the normal steering mechanism (queued and drained mid-flight).
 */
export class RoomMessageHandler {
  readonly resolver: CommandResolver;
  private readonly executor: CommandExecutor;
  private readonly steeringQueue: SteeringQueue;
  private readonly proactiveRunner: ProactiveRunner | null;
  private readonly history: ChatHistoryStore;
  private readonly logger: CommandExecutorLogger;

  constructor(
    runtime: MuaddibRuntime,
    roomName: string,
    overrides?: CommandExecutorOverrides,
  ) {
    this.executor = new CommandExecutor(runtime, roomName, overrides);
    this.resolver = this.executor.resolver;
    this.steeringQueue = new SteeringQueue();
    this.history = runtime.history;
    this.logger = runtime.logger.getLogger(`muaddib.rooms.command.${roomName}`);

    // Proactive interjection setup
    const roomConfig = runtime.config.getRoomConfig(roomName);
    const proactiveConfig = buildProactiveConfig(roomConfig.proactive, roomConfig.command!);

    if (proactiveConfig) {
      this.proactiveRunner = new ProactiveRunner({
        config: proactiveConfig,
        runtime,
        executor: this.executor,
        resolver: this.resolver,
        steeringQueue: this.steeringQueue,
        logger: this.logger,
      });
    } else {
      this.proactiveRunner = null;
    }
  }

  async handleIncomingMessage(
    message: RoomMessage,
    options: { isDirect: boolean; sendResponse?: (text: string) => Promise<void> },
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
        this.steeringQueue.createContextDrainer(SteeringQueue.keyForMessage(message)),
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
      this.steeringQueue.createContextDrainer(SteeringQueue.keyForMessage(message)),
    );
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
      try {
        await runnerItem.completion;
        return (runnerItem.result as CommandExecutionResult | null) ?? null;
      } catch {
        // Runner session failed — retry as a new session.
        return this.handleCommandMessage(message, triggerMessageId, sendResponse);
      }
    }

    try {
      if (runnerItem.triggerMessageId === null) {
        throw new Error("Runner command item is missing trigger message id.");
      }

      runnerItem.result = await this.executor.execute(
        runnerItem.message,
        runnerItem.triggerMessageId,
        runnerItem.sendResponse,
        this.steeringQueue.createContextDrainer(steeringKey),
      );

      this.steeringQueue.finishItem(runnerItem);
      this.steeringQueue.releaseSession(steeringKey);
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
      this.proactiveRunner.runSession(steeringKey, item).catch((error) => {
        this.logger.error("Proactive session failed", error);
      });
      await item.completion;
      return;
    }

    await this.executor.triggerAutoChronicler(message);
  }


}
