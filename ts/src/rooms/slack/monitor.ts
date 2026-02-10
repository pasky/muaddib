import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import type { RoomMessage } from "../message.js";
import { sendWithRateLimitRetry } from "../send-retry.js";

interface CommandLike {
  shouldIgnoreUser(nick: string): boolean;
  handleIncomingMessage(
    message: RoomMessage,
    options: { isDirect: boolean; sendResponse?: (text: string) => Promise<void> },
  ): Promise<{ response: string | null } | null>;
}

export interface SlackMonitorRoomConfig {
  enabled?: boolean;
}

export interface SlackMessageEvent {
  workspaceId: string;
  workspaceName?: string;
  channelId: string;
  channelName?: string;
  userId?: string;
  username: string;
  text: string;
  mynick: string;
  messageTs?: string;
  isDirectMessage?: boolean;
  mentionsBot?: boolean;
}

export interface SlackEventSource {
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  receiveEvent(): Promise<SlackMessageEvent | null>;
}

export interface SlackSender {
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  sendMessage(channelId: string, message: string): Promise<void>;
}

export interface SlackRoomMonitorOptions {
  roomConfig: SlackMonitorRoomConfig;
  history: ChatHistoryStore;
  commandHandler: CommandLike;
  eventSource?: SlackEventSource;
  sender?: SlackSender;
}

export class SlackRoomMonitor {
  constructor(private readonly options: SlackRoomMonitorOptions) {}

  async run(): Promise<void> {
    if (!this.options.eventSource) {
      return;
    }

    if (this.options.eventSource.connect) {
      await this.options.eventSource.connect();
    }

    const senderIsEventSource = Object.is(this.options.sender, this.options.eventSource);

    if (this.options.sender && !senderIsEventSource && this.options.sender.connect) {
      await this.options.sender.connect();
    }

    try {
      while (true) {
        const event = await this.options.eventSource.receiveEvent();
        if (!event) {
          break;
        }

        try {
          await this.processMessageEvent(event);
        } catch (error) {
          console.error("Slack monitor failed to process event; continuing", error);
        }
      }
    } finally {
      if (this.options.sender && !senderIsEventSource && this.options.sender.disconnect) {
        await this.options.sender.disconnect();
      }

      if (this.options.eventSource.disconnect) {
        await this.options.eventSource.disconnect();
      }
    }
  }

  async processMessageEvent(event: SlackMessageEvent): Promise<void> {
    if (!event.workspaceId || !event.channelId || !event.username || !event.text) {
      return;
    }

    if (this.options.commandHandler.shouldIgnoreUser(event.username)) {
      return;
    }

    const isDirect = Boolean(event.isDirectMessage || event.mentionsBot);
    const cleanedContent = isDirect ? normalizeDirectContent(event.text, event.mynick) : event.text;

    const message: RoomMessage = {
      serverTag: `slack:${event.workspaceName ?? event.workspaceId}`,
      channelName: event.channelName ?? event.channelId,
      nick: event.username,
      mynick: event.mynick,
      content: cleanedContent,
      platformId: event.messageTs,
    };

    const sender = this.options.sender;

    await this.options.commandHandler.handleIncomingMessage(message, {
      isDirect,
      sendResponse: sender
        ? async (text) => {
            await sendWithRateLimitRetry(
              async () => {
                await sender.sendMessage(event.channelId, text);
              },
              {
                platform: "slack",
                destination: event.channelId,
              },
            );
          }
        : undefined,
    });
  }
}

function normalizeDirectContent(content: string, mynick: string): string {
  const mentionOrNickPrefix = new RegExp(
    `^\\s*(?:<@\\w+>\\s*)?(?:${escapeRegExp(mynick)}[,:]?\\s*)?`,
    "i",
  );
  return content.replace(mentionOrNickPrefix, "").trim() || content.trim();
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
