import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import type { RoomConfig } from "../../config/muaddib-config.js";
import { CONSOLE_LOGGER, RuntimeLogWriter, type Logger } from "../../app/logging.js";
import { appendAttachmentBlock, escapeRegExp, nowMonotonicSeconds, requireNonEmptyString, sleep } from "../../utils/index.js";
import type { MuaddibRuntime } from "../../runtime.js";
import { RoomMessageHandler } from "../command/message-handler.js";
import { type RoomMessage, roomArc } from "../message.js";
import {
  sendWithRetryResult,
  type SendRetryEvent,
  createSendRetryEventLogger,
} from "../send-retry.js";
import { DiscordGatewayTransport } from "./transport.js";

interface CommandLike {
  handleIncomingMessage(
    message: RoomMessage,
    options: { isDirect: boolean; sendResponse?: (text: string) => Promise<void> },
  ): Promise<{ response: string | null } | null>;
}

export interface DiscordAttachment {
  url: string;
  contentType?: string;
  filename?: string;
  size?: number;
}

export interface DiscordMessageEvent {
  kind?: "message";
  guildId?: string;
  guildName?: string;
  channelId: string;
  channelName?: string;
  messageId?: string;
  threadId?: string;
  username: string;
  content: string;
  mynick: string;
  attachments?: DiscordAttachment[];
  botUserId?: string;
  isDirectMessage?: boolean;
  mentionsBot?: boolean;
  isFromSelf?: boolean;
}

export interface DiscordMessageEditEvent {
  kind: "message_edit";
  guildId?: string;
  guildName?: string;
  channelId: string;
  channelName?: string;
  messageId: string;
  username: string;
  content: string;
  isFromSelf?: boolean;
}

export type DiscordIncomingEvent = DiscordMessageEvent | DiscordMessageEditEvent;

export interface DiscordEventSource {
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  receiveEvent(): Promise<DiscordIncomingEvent | null>;
}

export interface DiscordSendOptions {
  replyToMessageId?: string;
  mentionAuthor?: boolean;
}

export interface DiscordSendResult {
  messageId?: string;
  content?: string;
}

export interface DiscordSender {
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  sendMessage(
    channelId: string,
    message: string,
    options?: DiscordSendOptions,
  ): Promise<DiscordSendResult | void>;
  editMessage?(
    channelId: string,
    messageId: string,
    message: string,
  ): Promise<DiscordSendResult | void>;
  setTypingIndicator?(channelId: string): Promise<void>;
  clearTypingIndicator?(channelId: string): Promise<void>;
}

export interface DiscordRoomMonitorOptions {
  roomConfig: RoomConfig;
  ignoreUsers?: string[];
  history: ChatHistoryStore;
  commandHandler: CommandLike;
  eventSource?: DiscordEventSource;
  sender?: DiscordSender;
  onSendRetryEvent?: (event: SendRetryEvent) => void;
  logger?: Logger;
  logWriter?: RuntimeLogWriter;
}

export class DiscordRoomMonitor {
  private readonly logger: Logger;
  private readonly logWriter?: RuntimeLogWriter;

  static fromRuntime(runtime: MuaddibRuntime): DiscordRoomMonitor[] {
    const roomConfig = runtime.config.getRoomConfig("discord");
    const enabled = roomConfig.enabled ?? false;
    if (!enabled) {
      return [];
    }

    const token = requireNonEmptyString(
      roomConfig.token,
      "Discord room is enabled but rooms.discord.token is missing.",
    );

    const commandHandler = new RoomMessageHandler(runtime, "discord");
    const transport = new DiscordGatewayTransport({
      token,
      botNameFallback: roomConfig.botName,
    });

    return [
      new DiscordRoomMonitor({
        roomConfig,
        ignoreUsers: roomConfig.command?.ignoreUsers?.map(String),
        history: runtime.history,
        commandHandler,
        eventSource: transport,
        sender: transport,
        onSendRetryEvent: createSendRetryEventLogger(
          runtime.logger.getLogger("muaddib.send-retry.discord"),
        ),
        logger: runtime.logger.getLogger("muaddib.rooms.discord.monitor"),
        logWriter: runtime.logger,
      }),
    ];
  }

  constructor(private readonly options: DiscordRoomMonitorOptions) {
    this.logger = options.logger ?? CONSOLE_LOGGER;
    this.logWriter = options.logWriter;
  }

  async run(): Promise<void> {
    if (!this.options.eventSource) {
      this.logger.warn("Discord monitor has no event source; skipping run.");
      return;
    }

    const senderIsEventSource = Object.is(this.options.sender, this.options.eventSource);
    const reconnect = this.options.roomConfig.reconnect;

    this.logger.info("Discord monitor starting.");

    let reconnectAttempts = 0;

    try {
      while (true) {
        let eventSourceConnected = false;
        let senderConnected = false;

        try {
          if (this.options.eventSource.connect) {
            await this.options.eventSource.connect();
            eventSourceConnected = true;
          }

          if (this.options.sender && !senderIsEventSource && this.options.sender.connect) {
            await this.options.sender.connect();
            senderConnected = true;
          }

          while (true) {
            const event = await this.options.eventSource.receiveEvent();
            if (!event) {
              this.logger.info(
                "Discord monitor received null event (graceful shutdown signal); stopping without reconnect.",
              );
              return;
            }

            try {
              if (isDiscordMessageEditEvent(event)) {
                await this.processMessageEditEvent(event);
              } else {
                await this.processMessageEvent(event);
              }
            } catch (error) {
              this.logger.error("Discord monitor failed to process event; continuing", error);
            }
          }
        } catch (error) {
          if (!(reconnect?.enabled ?? false)) {
            throw error;
          }

          reconnectAttempts += 1;
          if (reconnectAttempts > (reconnect?.maxAttempts ?? 5)) {
            throw error;
          }

          this.logger.warn(
            "Discord monitor receive loop failed; reconnecting",
            `attempt=${reconnectAttempts}`,
            `delay_ms=${(reconnect?.delayMs ?? 1_000)}`,
            error,
          );
        } finally {
          if (this.options.sender && !senderIsEventSource && senderConnected && this.options.sender.disconnect) {
            await this.options.sender.disconnect();
          }

          if (eventSourceConnected && this.options.eventSource.disconnect) {
            await this.options.eventSource.disconnect();
          }
        }

        await sleep((reconnect?.delayMs ?? 1_000));
      }
    } finally {
      this.logger.info("Discord monitor stopped.");
    }
  }

  async processMessageEvent(event: DiscordMessageEvent): Promise<void> {
    if (!event.channelId || !event.username || !event.content || !event.mynick) {
      return;
    }

    if (event.isFromSelf) {
      return;
    }

    const ignoreUsers = this.options.ignoreUsers ?? [];
    if (ignoreUsers.some((u) => u.toLowerCase() === event.username.toLowerCase())) {
      return;
    }

    const isDirect = Boolean(event.isDirectMessage || event.mentionsBot);
    const baseContent = normalizeDiscordEmoji(event.content).trim();
    const directOrPassiveContent = isDirect
      ? normalizeDirectContent(baseContent, event.mynick, event.botUserId)
      : baseContent;
    const attachmentBlock = buildDiscordAttachmentBlock(event.attachments ?? []);
    const cleanedContent = appendAttachmentBlock(directOrPassiveContent, attachmentBlock);

    if (!cleanedContent) {
      return;
    }

    const serverTag = event.guildName
      ? `discord:${event.guildName}`
      : event.guildId
        ? `discord:${event.guildId}`
        : "discord:_DM";

    let threadStarterId: number | undefined;
    if (event.threadId) {
      const starterId = await this.options.history.getMessageIdByPlatformId(
        serverTag,
        event.channelName ?? event.channelId,
        event.threadId,
      );
      if (starterId !== null) {
        threadStarterId = starterId;
      }
    }

    const message: RoomMessage = {
      serverTag,
      channelName: event.channelName ?? event.channelId,
      nick: event.username,
      mynick: event.mynick,
      content: cleanedContent,
      platformId: event.messageId,
      threadId: event.threadId,
      threadStarterId,
    };

    const sender = this.options.sender;
    const replyEditDebounceSeconds = this.options.roomConfig.replyEditDebounceSeconds ?? 15;
    let lastReplyMessageId: string | undefined;
    let lastReplyText: string | undefined;
    let lastReplyAtSeconds: number | undefined;

    const handleIncoming = async (): Promise<void> => {
      await this.options.commandHandler.handleIncomingMessage(message, {
        isDirect,
        sendResponse: sender
          ? async (text) => {
              const nowSeconds = nowMonotonicSeconds();

              if (
                sender.editMessage &&
                lastReplyMessageId &&
                lastReplyAtSeconds !== undefined &&
                nowSeconds - lastReplyAtSeconds < replyEditDebounceSeconds
              ) {
                const combined = lastReplyText ? `${lastReplyText}\n${text}` : text;
                const targetMessageId = lastReplyMessageId;

                const editResult = await sendWithRetryResult<DiscordSendResult>(
                  event.channelId,
                  "discord",
                  this.options.onSendRetryEvent,
                  async () => await sender.editMessage!(event.channelId, targetMessageId, combined),
                );

                if (editResult?.messageId) {
                  lastReplyMessageId = editResult.messageId;
                }
                lastReplyText = combined;
                lastReplyAtSeconds = nowSeconds;
                return;
              }

              const replyToMessageId = lastReplyMessageId ?? event.messageId;

              const sendResult = await sendWithRetryResult<DiscordSendResult>(
                event.channelId,
                "discord",
                this.options.onSendRetryEvent,
                async () =>
                  await sender.sendMessage(event.channelId, text, {
                    replyToMessageId,
                    mentionAuthor: Boolean(replyToMessageId && !lastReplyMessageId),
                  }),
              );

              if (sendResult?.messageId) {
                lastReplyMessageId = sendResult.messageId;
              }
              lastReplyText = text;
              lastReplyAtSeconds = nowSeconds;
            }
          : undefined,
      });
    };

    if (!isDirect) {
      await handleIncoming();
      return;
    }

    const arc = roomArc(message);
    const runDirectMessage = async (): Promise<void> => {
      this.logger.debug("Processing direct Discord message", `arc=${arc}`, `nick=${message.nick}`);
      await this.withTypingIndicator(event.channelId, async () => {
        await handleIncoming();
      });
    };

    if (this.logWriter) {
      await this.logWriter.withMessageContext({ arc, nick: message.nick, message: event.content }, runDirectMessage);
    } else {
      await runDirectMessage();
    }
  }

  private async withTypingIndicator(
    channelId: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const sender = this.options.sender;
    if (!sender?.setTypingIndicator) {
      await run();
      return;
    }

    await sender.setTypingIndicator(channelId);
    const refreshTimer = setInterval(() => {
      void sender.setTypingIndicator?.(channelId).catch((error) => {
        this.logger.warn("Discord typing indicator refresh failed", error);
      });
    }, 7_000);

    try {
      await run();
    } finally {
      clearInterval(refreshTimer);
      if (sender.clearTypingIndicator) {
        await sender.clearTypingIndicator(channelId);
      }
    }
  }

  async processMessageEditEvent(event: DiscordMessageEditEvent): Promise<void> {
    if (!event.channelId || !event.username || !event.messageId) {
      return;
    }

    if (event.isFromSelf) {
      return;
    }

    const newContent = normalizeDiscordEmoji(event.content).trim();
    if (!newContent) {
      return;
    }

    const serverTag = event.guildName
      ? `discord:${event.guildName}`
      : event.guildId
        ? `discord:${event.guildId}`
        : "discord:_DM";

    await this.options.history.updateMessageByPlatformId(
      serverTag,
      event.channelName ?? event.channelId,
      event.messageId,
      newContent,
      event.username,
    );
  }
}

function isDiscordMessageEditEvent(event: DiscordIncomingEvent): event is DiscordMessageEditEvent {
  return event.kind === "message_edit";
}

/** Strip custom Discord emoji markup to plain :name: form. */
export function normalizeDiscordEmoji(content: string): string {
  if (!content) {
    return content;
  }

  return content.replace(/<a?:([0-9A-Za-z_]+):\d+>/g, ":$1:");
}

function buildDiscordAttachmentBlock(attachments: DiscordAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }

  const lines = attachments
    .map((attachment, index) => {
      let meta = attachment.contentType || "attachment";
      if (attachment.filename) {
        meta += ` (filename: ${attachment.filename})`;
      }
      if (attachment.size) {
        meta += ` (size: ${attachment.size})`;
      }

      return `${index + 1}. ${meta}: ${attachment.url}`;
    })
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return "";
  }

  return ["[Attachments]", ...lines, "[/Attachments]"].join("\n");
}

function normalizeDirectContent(content: string, mynick: string, botUserId?: string): string {
  let cleaned = content.trimStart();

  if (botUserId) {
    const mentionPattern = new RegExp(`^\\s*(?:<@!?${escapeRegExp(botUserId)}>\\s*)+[:,]?\\s*(.*)$`, "i");
    const match = cleaned.match(mentionPattern);
    if (match) {
      cleaned = match[1]?.trim() ?? "";
    }
  }

  if (cleaned === content.trimStart()) {
    const anyMentionPattern = /^\s*(?:<@!?\w+>\s*)+[:,]?\s*(.*)$/i;
    const match = cleaned.match(anyMentionPattern);
    if (match) {
      cleaned = match[1]?.trim() ?? "";
    }
  }

  const namePattern = new RegExp(`^\\s*@?${escapeRegExp(mynick)}[:,]?\\s*(.*)$`, "i");
  const nameMatch = cleaned.match(namePattern);
  if (nameMatch) {
    cleaned = nameMatch[1]?.trim() ?? "";
  }

  return normalizeDiscordEmoji(cleaned || content.trim());
}
