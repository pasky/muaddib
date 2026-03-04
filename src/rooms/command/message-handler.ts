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
  type CommandExecutorOverrides,
  type CommandExecutorLogger,
  type SendResponse,
} from "./command-executor.js";
import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import { type RoomMessage, wrapSteeredMessage } from "../message.js";
import type { MuaddibRuntime } from "../../runtime.js";
import { formatUtcTime } from "../../utils/index.js";

// Re-export types that external consumers depend on
export type {
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
    options?: { sendResponse?: SendResponse },
  ): Promise<void> {
    const sendResponse: SendResponse = options?.sendResponse ?? (async () => {});
    const key = sessionKey(message);

    // ── Active session steering fast-path ──
    // Check for an active session BEFORE the async addMessage call.  Without
    // this, the addMessage await creates a gap during which the session can
    // complete and remove itself from activeSteers, causing later routing to
    // miss it.
    const existingSteer = this.activeSteers.get(key);
    let breakingActiveSession = false;

    if (existingSteer) {
      if (!message.isDirect || !this.resolver.shouldBreakActiveSession(message)) {
        // Regular follow-up (mode tokens, plain messages, passives) — steer
        // into the active session without blocking on history persistence.
        existingSteer(message);
        this.history.addMessage(message).catch((err) => {
          this.logger.error("Failed to persist steered message to history", String(err));
        });
        return;
      }

      // Session-breaking signal (!c, @model, !h, parse error) — execute as
      // a one-shot command without touching activeSteers.  The old session
      // keeps its entry and continues receiving steered messages.
      breakingActiveSession = true;
      this.logger.debug(
        "Breaking out of active session",
        `arc=${message.arc}`,
        `nick=${message.nick}`,
      );
    }

    // ── Persist trigger message ──
    const triggerTs = await this.history.addMessage(message, { selfRun: true });

    // ── Route: passive vs direct ──
    if (!message.isDirect) {
      this.logger.debug(
        "Handling passive message",
        `arc=${message.arc}`,
        `nick=${message.nick}`,
      );
      await this.handlePassiveMessage(message, sendResponse);
      return;
    }

    this.logger.debug(
      "Handling direct command",
      `arc=${message.arc}`,
      `nick=${message.nick}`,
    );

    try {
      // One-shot execute (no steering registration) for:
      // - Break-out messages from an active session (!c, @model, !h, parse errors)
      // - Messages that bypass steering on their own (help, parse errors,
      //   no-context, non-steering modes/channel policies)
      if (breakingActiveSession || this.resolver.shouldBypassSteering(message)) {
        await this.executor.execute(message, triggerTs, sendResponse);
        return;
      }

      await this.handleCommandMessage(message, triggerTs, sendResponse);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error("Agent execution failed", `nick=${message.nick}`, `error=${errorMsg}`);
      await sendResponse(errorMsg).catch((sendErr) => {
        this.logger.error("Failed to send error reply to room", sendErr);
      });
      throw error;
    }
  }

  // ── Session lifecycle: commands ──

  private async handleCommandMessage(
    message: RoomMessage,
    triggerTs: string,
    sendResponse: SendResponse,
  ): Promise<void> {
    const key = sessionKey(message);

    // Register a buffering steer function immediately so messages arriving
    // before the agent is created are captured and flushed once it's ready.
    const pending: RoomMessage[] = [];
    this.activeSteers.set(key, (msg) => { pending.push(msg); });

    try {
      await this.executor.execute(
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
    const baseText = `[${ts}] <${message.nick}> ${message.content}`;

    // Direct messages (in-channel mentions, DMs) are user follow-ups — steer
    // them verbatim. Passive/background messages get the "do not derail" wrapper.
    const content = message.isDirect ? baseText : wrapSteeredMessage(baseText);

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
    sendResponse: SendResponse,
  ): Promise<void> {
    // Passive messages with an active command session for this key are already
    // caught by the synchronous fast-path in handleIncomingMessage — they never
    // reach here.  This method only handles passives with no active command session.

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
