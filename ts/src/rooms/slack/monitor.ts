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

export interface SlackMonitorRoomConfig {
  enabled?: boolean;
  reply_start_thread?: {
    channel?: boolean;
    dm?: boolean;
  };
}

export interface SlackMessageEvent {
  kind?: "message";
  workspaceId: string;
  workspaceName?: string;
  channelId: string;
  channelName?: string;
  channelType?: string;
  userId?: string;
  username: string;
  text: string;
  mynick: string;
  botUserId?: string;
  messageTs?: string;
  threadTs?: string;
  isDirectMessage?: boolean;
  mentionsBot?: boolean;
  isFromSelf?: boolean;
}

export interface SlackMessageEditEvent {
  kind: "message_edit";
  workspaceId: string;
  workspaceName?: string;
  channelId: string;
  channelName?: string;
  channelType?: string;
  userId?: string;
  username: string;
  editedMessageTs: string;
  newText: string;
  isFromSelf?: boolean;
}

export type SlackIncomingEvent = SlackMessageEvent | SlackMessageEditEvent;

export interface SlackEventSource {
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  receiveEvent(): Promise<SlackIncomingEvent | null>;
}

export interface SlackSendOptions {
  threadTs?: string;
}

export interface SlackSender {
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  sendMessage(channelId: string, message: string, options?: SlackSendOptions): Promise<void>;
}

export interface SlackRoomMonitorOptions {
  roomConfig: SlackMonitorRoomConfig;
  history: ChatHistoryStore;
  commandHandler: CommandLike;
  eventSource?: SlackEventSource;
  sender?: SlackSender;
  onSendRetryEvent?: (event: SendRetryEvent) => void;
  logger?: RuntimeLogger;
}

export class SlackRoomMonitor {
  private readonly logger: RuntimeLogger;

  constructor(private readonly options: SlackRoomMonitorOptions) {
    this.logger = options.logger ?? createConsoleLogger("muaddib.rooms.slack.monitor");
  }

  async run(): Promise<void> {
    if (!this.options.eventSource) {
      this.logger.warn("Slack monitor has no event source; skipping run.");
      return;
    }

    const senderIsEventSource = Object.is(this.options.sender, this.options.eventSource);
    let eventSourceConnected = false;
    let senderConnected = false;

    this.logger.info("Slack monitor starting.");

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
          if (isSlackMessageEditEvent(event)) {
            await this.processMessageEditEvent(event);
          } else {
            await this.processMessageEvent(event);
          }
        } catch (error) {
          this.logger.error("Slack monitor failed to process event; continuing", error);
        }
      }
    } finally {
      if (this.options.sender && !senderIsEventSource && senderConnected && this.options.sender.disconnect) {
        await this.options.sender.disconnect();
      }

      if (eventSourceConnected && this.options.eventSource.disconnect) {
        await this.options.eventSource.disconnect();
      }

      this.logger.info("Slack monitor stopped.");
    }
  }

  async processMessageEvent(event: SlackMessageEvent): Promise<void> {
    if (!event.workspaceId || !event.channelId || !event.username || !event.text || !event.mynick) {
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
      ? normalizeDirectContent(event.text, event.mynick, event.botUserId)
      : event.text.trim();

    if (!cleanedContent) {
      return;
    }

    const serverTag = `slack:${event.workspaceName ?? event.workspaceId}`;
    const channelName = resolveSlackChannelName(event);

    const responseThreadId = resolveReplyThreadTs(this.options.roomConfig, event);
    const threadId = event.threadTs ?? responseThreadId;

    let threadStarterId: number | undefined;
    if (threadId) {
      const starterId = await this.options.history.getMessageIdByPlatformId(serverTag, channelName, threadId);
      if (starterId !== null) {
        threadStarterId = starterId;
      }
    }

    const message: RoomMessage = {
      serverTag,
      channelName,
      nick: event.username,
      mynick: event.mynick,
      content: cleanedContent,
      platformId: event.messageTs,
      threadId,
      threadStarterId,
      responseThreadId,
    };

    const sender = this.options.sender;

    await this.options.commandHandler.handleIncomingMessage(message, {
      isDirect,
      sendResponse: sender
        ? async (text) => {
            await sendWithRateLimitRetry(
              async () => {
                await sender.sendMessage(event.channelId, text, {
                  threadTs: responseThreadId,
                });
              },
              {
                platform: "slack",
                destination: event.channelId,
                onEvent: this.options.onSendRetryEvent,
              },
            );
          }
        : undefined,
    });
  }

  async processMessageEditEvent(event: SlackMessageEditEvent): Promise<void> {
    if (!event.workspaceId || !event.channelId || !event.username || !event.editedMessageTs) {
      return;
    }

    if (event.isFromSelf) {
      return;
    }

    const newText = event.newText.trim();
    if (!newText) {
      return;
    }

    const serverTag = `slack:${event.workspaceName ?? event.workspaceId}`;
    const channelName = resolveSlackChannelName(event);

    await this.options.history.updateMessageByPlatformId(
      serverTag,
      channelName,
      event.editedMessageTs,
      newText,
      event.username,
    );
  }
}

function isSlackMessageEditEvent(event: SlackIncomingEvent): event is SlackMessageEditEvent {
  return event.kind === "message_edit";
}

function resolveReplyThreadTs(
  roomConfig: SlackMonitorRoomConfig,
  event: Pick<SlackMessageEvent, "threadTs" | "messageTs" | "channelType" | "isDirectMessage">,
): string | undefined {
  if (event.threadTs) {
    return event.threadTs;
  }

  if (!event.messageTs) {
    return undefined;
  }

  const replyStartThread = roomConfig.reply_start_thread;
  const channelEnabled = replyStartThread?.channel ?? true;
  const dmEnabled = replyStartThread?.dm ?? false;

  if (isDirectMessageChannel(event.channelType, event.isDirectMessage)) {
    return dmEnabled ? event.messageTs : undefined;
  }

  return channelEnabled ? event.messageTs : undefined;
}

function isDirectMessageChannel(channelType: string | undefined, isDirectMessage: boolean | undefined): boolean {
  return channelType === "im" || Boolean(isDirectMessage);
}

function resolveSlackChannelName(
  event: Pick<SlackMessageEvent, "channelId" | "channelName" | "channelType" | "username" | "userId"> |
    Pick<SlackMessageEditEvent, "channelId" | "channelName" | "channelType" | "username" | "userId">,
): string {
  if (event.channelName) {
    return event.channelName;
  }

  if (event.channelType === "im" && event.userId) {
    return `${normalizeName(event.username)}_${event.userId}`;
  }

  return event.channelId;
}

function normalizeDirectContent(content: string, mynick: string, botUserId?: string): string {
  let cleaned = content.trimStart();

  if (botUserId) {
    const mentionPattern = new RegExp(`^\\s*(?:<@${escapeRegExp(botUserId)}>\\s*)+[:,]?\\s*(.*)$`, "i");
    const mentionMatch = cleaned.match(mentionPattern);
    if (mentionMatch) {
      cleaned = mentionMatch[1]?.trim() ?? "";
    }
  }

  const namePattern = new RegExp(`^\\s*@?${escapeRegExp(mynick)}[:,]?\\s*(.*)$`, "i");
  const nameMatch = cleaned.match(namePattern);
  if (nameMatch) {
    cleaned = nameMatch[1]?.trim() ?? "";
  }

  return cleaned || content.trim();
}

function normalizeName(name: string): string {
  return name.trim().split(/\s+/u).join("_");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
