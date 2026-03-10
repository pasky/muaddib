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
import type {
  NetworkAccessApprover,
  NetworkAccessApprovalRequest,
  NetworkAccessApprovalResult,
} from "../../agent/network-boundary.js";
import { formatUtcTime } from "../../utils/index.js";
import { parseSetKeyArgs } from "../../cost/user-key-store.js";

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

type ApprovalCommandAction = "approve" | "deny";

interface PendingNetworkApproval {
  id: string;
  arc: string;
  threadId?: string;
  canonicalUrl: string;
  resolve: (result: NetworkAccessApprovalResult) => void;
}

function parseApprovalCommand(content: string):
  | { action: ApprovalCommandAction; id: string }
  | { action: ApprovalCommandAction; error: string }
  | null {
  const trimmed = content.trim();
  const match = trimmed.match(/^!(approve|deny)\b/iu);
  if (!match) {
    return null;
  }

  const action = match[1].toLowerCase() as ApprovalCommandAction;
  const parts = trimmed.split(/\s+/u);
  if (parts.length !== 2 || parts[1].length === 0) {
    return { action, error: `Usage: !${action} <id>` };
  }

  return { action, id: parts[1] };
}

function isSameApprovalScope(pending: PendingNetworkApproval, message: RoomMessage): boolean {
  return pending.arc === message.arc && (pending.threadId ?? null) === (message.threadId ?? null);
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
  private readonly fallbackNetworkAccessApprover?: NetworkAccessApprover;

  /** Active steering functions keyed by session key, with the session's resolved mode. */
  private readonly activeSteers = new Map<string, { steer: (message: RoomMessage) => void; modeKey: string | null }>();
  private readonly pendingNetworkApprovals = new Map<string, PendingNetworkApproval>();
  private nextNetworkApprovalId = 1;

  constructor(
    runtime: MuaddibRuntime,
    roomName: string,
    overrides?: CommandExecutorOverrides,
  ) {
    this.executor = new CommandExecutor(runtime, roomName, overrides);
    this.resolver = this.executor.resolver;
    this.history = runtime.history;
    this.logger = runtime.logger.getLogger(`muaddib.rooms.command.${roomName}`);
    this.fallbackNetworkAccessApprover = runtime.networkAccessApprover;

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

  /** Execute an event-triggered command with quiet output, bypassing steering. */
  async executeEvent(
    message: RoomMessage,
    sendResponse: SendResponse,
  ): Promise<void> {
    await this.executor.executeEvent(message, sendResponse);
  }

  async handleIncomingMessage(
    message: RoomMessage,
    options?: { sendResponse?: SendResponse },
  ): Promise<void> {
    message = this.sanitizeSensitiveCommandMessage(message);
    const sendResponse: SendResponse = options?.sendResponse ?? (async () => {});
    if (await this.tryHandleApprovalCommand(message, sendResponse)) {
      return;
    }

    const key = sessionKey(message);

    // ── Active session steering fast-path ──
    // Check for an active session BEFORE the async addMessage call.  Without
    // this, the addMessage await creates a gap during which the session can
    // complete and remove itself from activeSteers, causing later routing to
    // miss it.
    const existingEntry = this.activeSteers.get(key);
    let breakingActiveSession = false;

    if (existingEntry) {
      if (!message.isDirect || !this.resolver.shouldBreakActiveSession(message)) {
        // Warn when an explicitly !-prefixed command is steered into a session
        // running in a different mode (the mode token is effectively ignored).
        this.warnOnModeMismatch(message, existingEntry.modeKey, sendResponse);

        // Regular follow-up (mode tokens, plain messages, passives) — steer
        // into the active session without blocking on history persistence.
        existingEntry.steer(message);
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

    // ── Route: passive vs direct ──
    // Passive messages are persisted WITHOUT selfRun so that
    // annotateInFlightTriggers doesn't permanently tag them as "in progress"
    // when the bot decides not to respond (the common case for ambient chatter).
    if (!message.isDirect) {
      await this.history.addMessage(message);
      this.logger.debug(
        "Handling passive message",
        `arc=${message.arc}`,
        `nick=${message.nick}`,
      );
      await this.handlePassiveMessage(message, sendResponse);
      return;
    }

    // ── Persist trigger message (direct commands only) ──
    const triggerTs = await this.history.addMessage(message, { selfRun: true });

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
      const networkAccessApprover = this.createNetworkAccessApprover(message, sendResponse);

      if (breakingActiveSession || this.resolver.shouldBypassSteering(message)) {
        await this.executor.execute(message, triggerTs, sendResponse, {
          networkAccessApprover,
        });
        return;
      }

      await this.handleCommandMessage(message, triggerTs, sendResponse, networkAccessApprover);
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
    networkAccessApprover: NetworkAccessApprover,
  ): Promise<void> {
    const key = sessionKey(message);

    // Resolve the mode for this session so we can detect cross-mode steering.
    const parsed = this.resolver.parsePrefix(message.content);
    let sessionModeKey: string | null = null;
    if (parsed.modeToken && !parsed.error && this.resolver.triggerToMode[parsed.modeToken]) {
      const { modeKey } = this.resolver.runtimeForTrigger(parsed.modeToken);
      sessionModeKey = modeKey;
    }

    // Register a buffering steer function immediately so messages arriving
    // before the agent is created are captured and flushed once it's ready.
    const pending: RoomMessage[] = [];
    this.activeSteers.set(key, { steer: (msg) => { pending.push(msg); }, modeKey: sessionModeKey });

    try {
      await this.executor.execute(message, triggerTs, sendResponse, {
        networkAccessApprover,
        onAgentCreated: (agent) => {
          // Flush buffered messages, then swap to direct steering.
          for (const buffered of pending) {
            this.steerAgent(agent, buffered);
          }
          pending.length = 0;
          this.activeSteers.set(key, { steer: (msg) => { this.steerAgent(agent, msg); }, modeKey: sessionModeKey });
        },
        onResponseDelivered: () => {
          // Deregister steering as soon as the response is delivered, before
          // background work (memory update, tool summary) begins — prevents
          // new messages from being steered into the session during that window.
          this.activeSteers.delete(key);
        },
      });
    } finally {
      // Safety fallback: ensure cleanup even if execute() throws before
      // invoking the onResponseDelivered callback.
      this.activeSteers.delete(key);
    }
  }

  private steerAgent(agent: Agent, message: RoomMessage): void {
    const ts = formatUtcTime().slice(-5);
    const nickContent = message.trusted === false
      ? `[UNTRUSTED] <${message.nick}> ${message.content}[/UNTRUSTED]`
      : `<${message.nick}> ${message.content}`;
    const baseText = `[${ts}] ${nickContent}`;

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

  /**
   * Send a user-visible warning when a message with an explicit !-prefixed
   * mode token is steered into a session running in a different mode.
   * The mode token is effectively ignored and the user should know.
   */
  private warnOnModeMismatch(message: RoomMessage, sessionModeKey: string | null, sendResponse: SendResponse): void {
    const parsed = this.resolver.parsePrefix(message.content);
    if (!parsed.modeToken || parsed.error || !this.resolver.triggerToMode[parsed.modeToken]) return;

    const incomingModeKey = this.resolver.runtimeForTrigger(parsed.modeToken).modeKey;
    if (incomingModeKey === sessionModeKey) return;

    const warning = `${message.nick}: (warning: ${parsed.modeToken} ignored, follow-up steered into active ${sessionModeKey ?? "unknown"} session. !c / @-model would start a new session.)`;
    sendResponse(warning).catch((err) => {
      this.logger.error("Failed to send cross-mode steering warning", String(err));
    });
  }

  private sanitizeSensitiveCommandMessage(message: RoomMessage): RoomMessage {
    const parsed = this.resolver.parsePrefix(message.content);
    if (parsed.modeToken !== "!setkey") {
      return message;
    }

    const parsedArgs = parseSetKeyArgs(parsed.queryText);
    if (!parsedArgs?.key) {
      return message;
    }

    const sanitizedQuery = `${parsedArgs.provider} [redacted]`;
    const sanitizedContent = message.content.replace(parsed.queryText.trim(), sanitizedQuery);
    const sanitizedOriginalContent = message.originalContent
      ? message.originalContent.includes(message.content)
        ? message.originalContent.replace(message.content, sanitizedContent)
        : sanitizedContent
      : undefined;

    return {
      ...message,
      content: sanitizedContent,
      originalContent: sanitizedOriginalContent,
      secrets: {
        ...(message.secrets ?? {}),
        setkeyKey: parsedArgs.key,
      },
    };
  }

  private createNetworkAccessApprover(
    message: RoomMessage,
    sendResponse: SendResponse,
  ): NetworkAccessApprover {
    return async (request) => {
      if (this.fallbackNetworkAccessApprover) {
        return await this.fallbackNetworkAccessApprover(request);
      }

      const id = String(this.nextNetworkApprovalId++);
      const approval = new Promise<NetworkAccessApprovalResult>((resolve) => {
        this.pendingNetworkApprovals.set(id, {
          id,
          arc: request.arc,
          threadId: message.threadId,
          canonicalUrl: request.canonicalUrl,
          resolve,
        });
      });

      try {
        await sendResponse(this.buildApprovalRequestMessage(id, request));
      } catch (error) {
        this.pendingNetworkApprovals.delete(id);
        throw error;
      }

      return await approval;
    };
  }

  private async tryHandleApprovalCommand(
    message: RoomMessage,
    sendResponse: SendResponse,
  ): Promise<boolean> {
    const parsed = parseApprovalCommand(message.content);
    if (!parsed) {
      return false;
    }

    if ("error" in parsed) {
      await sendResponse(`${message.nick}: ${parsed.error}`);
      return true;
    }

    const pending = this.pendingNetworkApprovals.get(parsed.id);
    if (!pending) {
      await sendResponse(`${message.nick}: No pending network access request ${parsed.id}.`);
      return true;
    }

    if (!isSameApprovalScope(pending, message)) {
      await sendResponse(`${message.nick}: Network access request ${parsed.id} is pending in a different room or thread.`);
      return true;
    }

    const approved = parsed.action === "approve";
    this.pendingNetworkApprovals.delete(parsed.id);
    await sendResponse(
      `${message.nick}: ${approved ? "approved" : "denied"} network access request ${parsed.id} for ${pending.canonicalUrl}.`,
    ).catch((error) => {
      this.logger.error("Failed to send network approval resolution", String(error));
    });
    pending.resolve({
      approved,
      message: approved
        ? `Network access approved for ${pending.canonicalUrl}.`
        : `Network access denied for ${pending.canonicalUrl}.`,
    });
    return true;
  }

  private buildApprovalRequestMessage(id: string, request: NetworkAccessApprovalRequest): string {
    const reasonSuffix = request.reason ? ` Reason: ${request.reason}` : "";
    return `Network access request ${id} for ${request.canonicalUrl}.${reasonSuffix} Reply !approve ${id} or !deny ${id}.`;
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
