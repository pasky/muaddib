import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import { createConsoleLogger, type RuntimeLogger } from "../../app/logging.js";
import type { RoomMessage } from "../message.js";
import {
  sendWithRateLimitRetry,
  type SendRetryEvent,
} from "../send-retry.js";

interface CommandLike {
  shouldIgnoreUser(nick: string): boolean;
  handleIncomingMessage(
    message: RoomMessage,
    options: { isDirect: boolean; sendResponse?: (text: string) => Promise<void> },
  ): Promise<{ response: string | null } | null>;
}

export interface DiscordMonitorRoomConfig {
  enabled?: boolean;
  bot_name?: string;
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

export interface DiscordSender {
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  sendMessage(channelId: string, message: string, options?: DiscordSendOptions): Promise<void>;
}

export interface DiscordRoomMonitorOptions {
  roomConfig: DiscordMonitorRoomConfig;
  history: ChatHistoryStore;
  commandHandler: CommandLike;
  eventSource?: DiscordEventSource;
  sender?: DiscordSender;
  onSendRetryEvent?: (event: SendRetryEvent) => void;
  logger?: RuntimeLogger;
}

export class DiscordRoomMonitor {
  private readonly logger: RuntimeLogger;

  constructor(private readonly options: DiscordRoomMonitorOptions) {
    this.logger = options.logger ?? createConsoleLogger("muaddib.rooms.discord.monitor");
  }

  async run(): Promise<void> {
    if (!this.options.eventSource) {
      this.logger.warn("Discord monitor has no event source; skipping run.");
      return;
    }

    const senderIsEventSource = Object.is(this.options.sender, this.options.eventSource);
    let eventSourceConnected = false;
    let senderConnected = false;

    this.logger.info("Discord monitor starting.");

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
          break;
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
    } finally {
      if (this.options.sender && !senderIsEventSource && senderConnected && this.options.sender.disconnect) {
        await this.options.sender.disconnect();
      }

      if (eventSourceConnected && this.options.eventSource.disconnect) {
        await this.options.eventSource.disconnect();
      }

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

    if (this.options.commandHandler.shouldIgnoreUser(event.username)) {
      return;
    }

    const isDirect = Boolean(event.isDirectMessage || event.mentionsBot);
    const cleanedContent = isDirect
      ? normalizeDirectContent(event.content, event.mynick, event.botUserId)
      : normalizeContent(event.content).trim();

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

    const handleIncoming = async (): Promise<void> => {
      await this.options.commandHandler.handleIncomingMessage(message, {
        isDirect,
        sendResponse: sender
          ? async (text) => {
              await sendWithRateLimitRetry(
                async () => {
                  await sender.sendMessage(event.channelId, text, {
                    replyToMessageId: event.messageId,
                    mentionAuthor: true,
                  });
                },
                {
                  platform: "discord",
                  destination: event.channelId,
                  onEvent: this.options.onSendRetryEvent,
                },
              );
            }
          : undefined,
      });
    };

    if (!isDirect) {
      await handleIncoming();
      return;
    }

    const arc = `${message.serverTag}#${message.channelName}`;
    await this.logger.withMessageContext(
      {
        arc,
        nick: message.nick,
        message: event.content,
      },
      async () => {
        this.logger.debug("Processing direct Discord message", `arc=${arc}`, `nick=${message.nick}`);
        await handleIncoming();
      },
    );
  }

  async processMessageEditEvent(event: DiscordMessageEditEvent): Promise<void> {
    if (!event.channelId || !event.username || !event.messageId) {
      return;
    }

    if (event.isFromSelf) {
      return;
    }

    const newContent = normalizeContent(event.content).trim();
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

function normalizeContent(content: string): string {
  if (!content) {
    return content;
  }

  return content.replace(/<a?:([0-9A-Za-z_]+):\d+>/g, ":$1:");
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

  return normalizeContent(cleaned || content.trim());
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
