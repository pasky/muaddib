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
  type SendResponse,
} from "./command-executor.js";
import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import { type RoomMessage, STEER_PREFIX } from "../message.js";
import type { MuaddibRuntime } from "../../runtime.js";
import { formatUtcTime } from "../../utils/index.js";

// Re-export types that external consumers depend on
export type {
  CommandExecutionResult,
  CommandRunnerFactory,
  CommandRunnerFactoryInput,
  CommandRateLimiter,
  CommandExecutorOverrides,
  SendResponse,
  SendResult,
} from "./command-executor.js";

/** Key for session isolation: arc + nick (or arc + thread for threaded messages). */
function sessionKey(message: RoomMessage): string {
  const arc = message.arc;
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
    options: { isDirect: boolean; sendResponse?: SendResponse },
  ): Promise<CommandExecutionResult | null> {
    // ── Synchronous steer fast-path ──
    // Check for an active session BEFORE the async addMessage call.  Without
    // this, the addMessage await creates a gap during which the session can
    // complete and remove itself from activeSteers, causing the later check
    // in handleCommandMessage / handlePassiveMessage to miss it.
    const canSteer = !options.isDirect || !this.resolver.shouldBypassSteering(message);
    if (canSteer) {
      const key = sessionKey(message);
      const existing = this.activeSteers.get(key);
      if (existing) {
        existing(message);
        // Persist to history without blocking the steer path.
        this.history.addMessage(message).catch((err) => {
          this.logger.error("Failed to persist steered message to history", String(err));
        });
        return null;
      }
    }

    const triggerTs = await this.history.addMessage(message, { selfRun: true });

    if (!options.isDirect) {
      this.logger.debug(
        "Handling passive message",
        `arc=${message.arc}`,
        `nick=${message.nick}`,
      );
      await this.handlePassiveMessage(message, options.sendResponse);
      return null;
    }

    this.logger.debug(
      "Handling direct command",
      `arc=${message.arc}`,
      `nick=${message.nick}`,
    );

    // Messages that bypass steering (help, parse errors, no-context, non-steering modes)
    try {
      if (this.resolver.shouldBypassSteering(message)) {
        return await this.executor.execute(message, triggerTs, options.sendResponse);
      }

      return await this.handleCommandMessage(message, triggerTs, options.sendResponse);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error("Agent execution failed", `nick=${message.nick}`, `error=${errorMsg}`);
      if (options.sendResponse) {
        await options.sendResponse(errorMsg).catch((sendErr) => {
          this.logger.error("Failed to send error reply to room", sendErr);
        });
      }
      throw error;
    }
  }

  /** Direct execution without steering (for CLI / tests). */
  async execute(message: RoomMessage): Promise<CommandExecutionResult> {
    return this.executor.execute(message, "", undefined);
  }

  // ── Session lifecycle: commands ──

  private async handleCommandMessage(
    message: RoomMessage,
    triggerTs: string,
    sendResponse: SendResponse | undefined,
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
        message, triggerTs, sendResponse,
        (agent) => {
          // Flush buffered messages, then swap to direct steering.
          for (const buffered of pending) {
            this.steerAgent(agent, buffered);
          }
          pending.length = 0;
          this.activeSteers.set(key, (msg) => { this.steerAgent(agent, msg); });
        },
        () => {
          // Deregister steering as soon as the response is delivered, before
          // background work (memory update, tool summary) begins — prevents
          // new messages from being steered into the session during that window.
          this.activeSteers.delete(key);
        },
      );
    } finally {
      // Safety fallback: ensure cleanup even if execute() throws before
      // invoking the onResponseDelivered callback.
      this.activeSteers.delete(key);
    }
  }

  private steerAgent(agent: Agent, message: RoomMessage): void {
    const ts = formatUtcTime().slice(-5);
    const content = `${STEER_PREFIX}[${ts}] <${message.nick}> ${message.content}`;
    agent.steer({
      role: "user",
      content: [{ type: "text", text: content }],
      timestamp: Date.now(),
    });
    this.logger.info(
      "Steered message into active session",
      `arc=${message.arc}`,
      `nick=${message.nick}`,
      `content=${message.content}`,
    );
  }

  /** Check if any command session is active for the given channel arc (serverTag#channelName). */
  private hasActiveCommandSessionForChannel(arc: string): boolean {
    const prefix = `${arc}\0`;
    for (const key of this.activeSteers.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  // ── Session lifecycle: passives ──

  private async handlePassiveMessage(
    message: RoomMessage,
    sendResponse: SendResponse | undefined,
  ): Promise<void> {
    const key = sessionKey(message);

    // If there's an active command session for this key, steer into it
    const existing = this.activeSteers.get(key);
    if (existing) {
      existing(message);
      return;
    }

    // Try proactive: steer into running proactive agent, or start new session.
    // Check ANY active command session in the same channel (not just same nick)
    // to avoid launching a proactive agent that duplicates an in-flight command.
    const arc = message.arc;
    this.proactiveRunner?.steerOrStart(
      message,
      sendResponse,
      () => this.hasActiveCommandSessionForChannel(arc),
    );

    await this.executor.triggerAutoChronicler(message);
  }
}
