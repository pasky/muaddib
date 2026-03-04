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
  private readonly activeSteers = new Map<string, (message: RoomMessage, isDirect: boolean) => void>();

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
  ): Promise<void> {
    // Wrap optional sendResponse with a no-op so all internal paths receive a
    // required SendResponse without needing to guard against undefined.
    const sendResponse: SendResponse = options.sendResponse ?? (async () => {});

    // ── Synchronous steer fast-path ──
    // Check for an active session BEFORE the async addMessage call.  Without
    // this, the addMessage await creates a gap during which the session can
    // complete and remove itself from activeSteers, causing the later check
    // in handleCommandMessage / handlePassiveMessage to miss it.
    const key = sessionKey(message);
    const existing = this.activeSteers.get(key);

    if (existing) {
      // When a session is already active, steer follow-up messages into it
      // unless the message carries an explicit non-steering command.
      //
      // Plain messages (no mode token, no model override, no errors) always
      // steer — this overrides channel policy so e.g. a "!d"-forced channel
      // doesn't block follow-ups to an active "!s" session.  Passive channel
      // messages (parsed=null) also always steer.
      //
      // Messages with explicit commands (mode tokens, model overrides) defer
      // to shouldBypassSteering() which checks the mode's steering support.
      const parsed = options.isDirect ? this.resolver.parsePrefix(message.content) : null;
      const isPlainFollowup = parsed == null || (
        !parsed.error &&
        !parsed.noContext &&
        parsed.modeToken === null &&
        parsed.modelOverride === null
      );
      const shouldSteer = isPlainFollowup || !this.resolver.shouldBypassSteering(message);

      if (shouldSteer) {
        existing(message, options.isDirect);
        // Persist to history without blocking the steer path.
        this.history.addMessage(message).catch((err) => {
          this.logger.error("Failed to persist steered message to history", String(err));
        });
        return;
      }
    }

    const triggerTs = await this.history.addMessage(message, { selfRun: true });

    if (!options.isDirect) {
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

    // Messages that bypass steering (help, parse errors, no-context, non-steering modes)
    try {
      if (this.resolver.shouldBypassSteering(message)) {
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
    const existing = this.activeSteers.get(key);

    if (existing) {
      existing(message, true);
      return;
    }

    // Register a buffering steer function immediately so messages arriving
    // before the agent is created are captured and flushed once it's ready.
    const pending: { message: RoomMessage; isDirect: boolean }[] = [];
    this.activeSteers.set(key, (msg, isDirect) => { pending.push({ message: msg, isDirect }); });

    try {
      await this.executor.execute(
        message, triggerTs, sendResponse,
        (agent) => {
          // Flush buffered messages, then swap to direct steering.
          for (const buffered of pending) {
            this.steerAgent(agent, buffered.message, buffered.isDirect);
          }
          pending.length = 0;
          this.activeSteers.set(key, (msg, isDirect) => { this.steerAgent(agent, msg, isDirect); });
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

  private steerAgent(agent: Agent, message: RoomMessage, isDirect: boolean): void {
    const ts = formatUtcTime().slice(-5);
    const baseText = `[${ts}] <${message.nick}> ${message.content}`;

    // Direct messages (in-channel mentions, DMs) are user follow-ups — steer
    // them verbatim. Passive/background messages get the "do not derail" wrapper.
    const content = isDirect ? baseText : wrapSteeredMessage(baseText);

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
    const key = sessionKey(message);

    // If there's an active command session for this key, steer into it
    const existing = this.activeSteers.get(key);
    if (existing) {
      existing(message, false);
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
