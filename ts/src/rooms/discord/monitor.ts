import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import type { RoomMessage } from "../message.js";

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
  guildId?: string;
  channelId: string;
  channelName?: string;
  username: string;
  content: string;
  mynick: string;
  isDirectMessage?: boolean;
  mentionsBot?: boolean;
}

export interface DiscordEventSource {
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  receiveEvent(): Promise<DiscordMessageEvent | null>;
}

export interface DiscordSender {
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  sendMessage(channelId: string, message: string): Promise<void>;
}

export interface DiscordRoomMonitorOptions {
  roomConfig: DiscordMonitorRoomConfig;
  history: ChatHistoryStore;
  commandHandler: CommandLike;
  eventSource?: DiscordEventSource;
  sender?: DiscordSender;
}

export class DiscordRoomMonitor {
  constructor(private readonly options: DiscordRoomMonitorOptions) {}

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
        await this.processMessageEvent(event);
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

  async processMessageEvent(event: DiscordMessageEvent): Promise<void> {
    if (!event.channelId || !event.username || !event.content) {
      return;
    }

    if (this.options.commandHandler.shouldIgnoreUser(event.username)) {
      return;
    }

    const isDirect = Boolean(event.isDirectMessage || event.mentionsBot);
    const cleanedContent = isDirect ? normalizeDirectContent(event.content, event.mynick) : event.content;

    const message: RoomMessage = {
      serverTag: event.guildId ? `discord:${event.guildId}` : "discord:dm",
      channelName: event.channelName ?? event.channelId,
      nick: event.username,
      mynick: event.mynick,
      content: cleanedContent,
      platformId: event.channelId,
    };

    await this.options.commandHandler.handleIncomingMessage(message, {
      isDirect,
      sendResponse: this.options.sender
        ? async (text) => {
            await this.options.sender?.sendMessage(event.channelId, text);
          }
        : undefined,
    });
  }
}

function normalizeDirectContent(content: string, mynick: string): string {
  const mentionOrNickPrefix = new RegExp(
    `^\\s*(?:<@!?\\w+>\\s*)?(?:${escapeRegExp(mynick)}[,:]?\\s*)?`,
    "i",
  );
  return content.replace(mentionOrNickPrefix, "").trim() || content.trim();
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
