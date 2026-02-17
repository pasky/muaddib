/**
 * Room message handler — session lifecycle coordinator.
 *
 * Maintains a map of active agent sessions keyed by (arc, nick, thread).
 * When a message arrives for a key with an active session, it steers
 * the running agent via agent.steer(). Otherwise, a new session is created.
 *
 * Delegates execution to CommandExecutor and proactive interjection to ProactiveRunner.
 */

import type { Agent } from "@mariozechner/pi-agent-core";
import { CommandResolver } from "./resolver.js";
import { buildProactiveConfig, ProactiveRunner } from "./proactive.js";
import {
  CommandExecutor,
  type CommandExecutionResult,
  type CommandExecutorOverrides,
  type CommandExecutorLogger,
} from "./command-executor.js";
import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import { type RoomMessage, roomArc } from "../message.js";
import type { MuaddibRuntime } from "../../runtime.js";

// Re-export types that external consumers depend on
export type {
  CommandExecutionResult,
  CommandRunnerFactory,
  CommandRunnerFactoryInput,
  CommandRateLimiter,
  CommandExecutorOverrides,
} from "./command-executor.js";

/** Key for session isolation: arc + nick (or arc + thread for threaded messages). */
function sessionKey(message: RoomMessage): string {
  const arc = roomArc(message);
  if (message.threadId) {
    return `${arc}\0*\0${message.threadId}`;
  }
  return `${arc}\0${message.nick.toLowerCase()}\0`;
}

/**
 * Shared room message handling path with proactive interjection support.
 *
 * Active agent sessions are tracked in a map. Messages arriving for a key
 * with a running session are steered into the agent via agent.steer().
 * The session is removed from the map when execution completes.
 */
export class RoomMessageHandler {
  readonly resolver: CommandResolver;
  private readonly executor: CommandExecutor;
  private readonly proactiveRunner: ProactiveRunner | null;
  private readonly history: ChatHistoryStore;
  private readonly logger: CommandExecutorLogger;

  /** Active steering functions keyed by session key. */
  private readonly activeSteers = new Map<string, (message: RoomMessage) => void>();

  constructor(
    runtime: MuaddibRuntime,
    roomName: string,
    overrides?: CommandExecutorOverrides,
  ) {
    this.executor = new CommandExecutor(runtime, roomName, overrides);
    this.resolver = this.executor.resolver;
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
        logger: this.logger,
      });
    } else {
      this.proactiveRunner = null;
    }
  }

  /** Cancel all proactive sessions. Safe to call multiple times. */
  cancelProactive(): void {
    this.proactiveRunner?.cancelAll();
  }

  async handleIncomingMessage(
    message: RoomMessage,
    options: { isDirect: boolean; sendResponse?: (text: string) => Promise<void> },
  ): Promise<CommandExecutionResult | null> {
    const triggerMessageId = await this.history.addMessage(message);

    if (!options.isDirect) {
      this.logger.debug(
        "Handling passive message",
        `arc=${roomArc(message)}`,
        `nick=${message.nick}`,
      );
      await this.handlePassiveMessage(message, options.sendResponse);
      return null;
    }

    this.logger.debug(
      "Handling direct command",
      `arc=${roomArc(message)}`,
      `nick=${message.nick}`,
    );

    // Messages that bypass steering (help, parse errors, no-context, non-steering modes)
    if (this.resolver.shouldBypassSteering(message)) {
      return this.executor.execute(message, triggerMessageId, options.sendResponse);
    }

    return this.handleCommandMessage(message, triggerMessageId, options.sendResponse);
  }

  /** Direct execution without steering (for CLI / tests). */
  async execute(message: RoomMessage): Promise<CommandExecutionResult> {
    return this.executor.execute(message, 0, undefined);
  }

  // ── Session lifecycle: commands ──

  private async handleCommandMessage(
    message: RoomMessage,
    triggerMessageId: number,
    sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<CommandExecutionResult | null> {
    const key = sessionKey(message);
    const existing = this.activeSteers.get(key);

    if (existing) {
      existing(message);
      return null;
    }

    // Register a buffering steer function immediately so messages arriving
    // before the agent is created are captured and flushed once it's ready.
    const pending: RoomMessage[] = [];
    this.activeSteers.set(key, (msg) => { pending.push(msg); });

    try {
      return await this.executor.execute(
        message, triggerMessageId, sendResponse,
        (agent) => {
          // Flush buffered messages, then swap to direct steering.
          for (const buffered of pending) {
            this.steerAgent(agent, buffered);
          }
          pending.length = 0;
          this.activeSteers.set(key, (msg) => { this.steerAgent(agent, msg); });
        },
      );
    } finally {
      this.activeSteers.delete(key);
    }
  }

  private steerAgent(agent: Agent, message: RoomMessage): void {
    const content = `<${message.nick}> ${message.content}`;
    agent.steer({
      role: "user",
      content: [{ type: "text", text: content }],
      timestamp: Date.now(),
    });
    this.logger.debug(
      "Steered message into active session",
      `arc=${roomArc(message)}`,
      `nick=${message.nick}`,
    );
  }

  // ── Session lifecycle: passives ──

  private async handlePassiveMessage(
    message: RoomMessage,
    sendResponse: ((text: string) => Promise<void>) | undefined,
  ): Promise<void> {
    const key = sessionKey(message);

    // If there's an active command session for this key, steer into it
    const existing = this.activeSteers.get(key);
    if (existing) {
      existing(message);
      return;
    }

    // Try proactive: steer into running proactive agent, or start new session
    this.proactiveRunner?.steerOrStart(
      message,
      sendResponse,
      () => this.activeSteers.has(sessionKey(message)),
    );

    await this.executor.triggerAutoChronicler(message);
  }
}
