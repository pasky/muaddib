import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import type { RoomMessage } from "../message.js";

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
  channelId: string;
  channelName?: string;
  username: string;
  text: string;
  mynick: string;
  isDirectMessage?: boolean;
  mentionsBot?: boolean;
}

export interface SlackEventSource {
  receiveEvent(): Promise<SlackMessageEvent | null>;
}

export interface SlackSender {
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

    while (true) {
      const event = await this.options.eventSource.receiveEvent();
      if (!event) {
        break;
      }
      await this.processMessageEvent(event);
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
      serverTag: `slack:${event.workspaceId}`,
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
  const mentionPattern = new RegExp(`^\\s*(<@\\w+>\\s*)?${escapeRegExp(mynick)}[,:]?\\s*`, "i");
  return content.replace(mentionPattern, "").trim() || content.trim();
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
