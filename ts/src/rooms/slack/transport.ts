import { App } from "@slack/bolt";

import type {
  SlackEventSource,
  SlackIncomingEvent,
  SlackMessageEditEvent,
  SlackMessageEvent,
  SlackSendOptions,
  SlackSender,
} from "./monitor.js";

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  async shift(): Promise<T> {
    if (this.items.length > 0) {
      return this.items.shift() as T;
    }

    return await new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export interface SlackSocketTransportOptions {
  appToken: string;
  botToken: string;
  workspaceId: string;
  workspaceName?: string;
  botNameFallback?: string;
}

/**
 * Real Slack socket-mode transport behind monitor abstractions.
 */
export class SlackSocketTransport implements SlackEventSource, SlackSender {
  private readonly queue = new AsyncQueue<SlackIncomingEvent | null>();
  private readonly app: App;
  private connected = false;
  private botUserId: string | null = null;
  private botDisplayName: string | null = null;
  private readonly userDisplayNameCache = new Map<string, string>();
  private readonly channelNameCache = new Map<string, string>();

  constructor(private readonly options: SlackSocketTransportOptions) {
    this.app = new App({
      token: options.botToken,
      appToken: options.appToken,
      socketMode: true,
    });

    this.app.event("message", async ({ event }) => {
      const mapped = await this.mapEvent(event as unknown as Record<string, unknown>);
      if (mapped) {
        this.queue.push(mapped);
      }
    });

    this.app.error(async () => {
      this.queue.push(null);
    });
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    await this.app.start();
    this.connected = true;

    const auth = await this.app.client.auth.test({
      token: this.options.botToken,
    });

    const userId = auth.user_id;
    if (typeof userId === "string") {
      this.botUserId = userId;
      this.botDisplayName = await this.getUserDisplayName(userId);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    this.connected = false;
    await this.app.stop();
    this.queue.push(null);
  }

  async receiveEvent(): Promise<SlackIncomingEvent | null> {
    return await this.queue.shift();
  }

  async sendMessage(channelId: string, message: string, options?: SlackSendOptions): Promise<void> {
    await this.app.client.chat.postMessage({
      channel: channelId,
      text: message,
      thread_ts: options?.threadTs,
      token: this.options.botToken,
    });
  }

  private async mapEvent(event: Record<string, unknown>): Promise<SlackIncomingEvent | null> {
    const subtype = typeof event.subtype === "string" ? event.subtype : undefined;

    if (subtype === "message_changed") {
      return await this.mapMessageEdit(event);
    }

    if (subtype && subtype !== "file_share" && subtype !== "me_message") {
      return null;
    }

    return await this.mapMessage(event);
  }

  private async mapMessage(event: Record<string, unknown>): Promise<SlackMessageEvent | null> {
    const rawText = typeof event.text === "string" ? event.text : "";
    const channelId = typeof event.channel === "string" ? event.channel : "";
    const userId = typeof event.user === "string" ? event.user : "";

    if (!rawText || !channelId || !userId) {
      return null;
    }

    const channelType = typeof event.channel_type === "string" ? event.channel_type : undefined;
    const isDirectMessage = channelType === "im" || channelId.startsWith("D");
    const mentionsBot = this.botUserId ? rawText.includes(`<@${this.botUserId}>`) : false;
    const username = await this.getUserDisplayName(userId);
    const normalizedText = await this.normalizeIncomingText(rawText);

    let channelName: string;
    if (isDirectMessage) {
      channelName = `${normalizeName(username)}_${userId}`;
    } else {
      const name = await this.getChannelName(channelId);
      channelName = `#${name}`;
    }

    return {
      kind: "message",
      workspaceId: this.options.workspaceId,
      workspaceName: this.options.workspaceName ?? this.options.workspaceId,
      channelId,
      channelName,
      channelType,
      userId,
      username,
      text: normalizedText,
      mynick: this.botDisplayName ?? this.options.botNameFallback ?? "muaddib",
      botUserId: this.botUserId ?? undefined,
      messageTs: typeof event.ts === "string" ? event.ts : undefined,
      threadTs: typeof event.thread_ts === "string" ? event.thread_ts : undefined,
      isDirectMessage,
      mentionsBot,
      isFromSelf: this.botUserId ? userId === this.botUserId : false,
    };
  }

  private async mapMessageEdit(event: Record<string, unknown>): Promise<SlackMessageEditEvent | null> {
    const channelId = typeof event.channel === "string" ? event.channel : "";
    const channelType = typeof event.channel_type === "string" ? event.channel_type : undefined;
    const message = asRecord(event.message);
    if (!channelId || !message) {
      return null;
    }

    const userId = typeof message.user === "string" ? message.user : "";
    const editedMessageTs = typeof message.ts === "string" ? message.ts : "";
    const rawText = typeof message.text === "string" ? message.text : "";

    if (!userId || !editedMessageTs || !rawText) {
      return null;
    }

    const username = await this.getUserDisplayName(userId);
    const normalizedText = await this.normalizeIncomingText(rawText);

    let channelName: string;
    if (channelType === "im" || channelId.startsWith("D")) {
      channelName = `${normalizeName(username)}_${userId}`;
    } else {
      const name = await this.getChannelName(channelId);
      channelName = `#${name}`;
    }

    return {
      kind: "message_edit",
      workspaceId: this.options.workspaceId,
      workspaceName: this.options.workspaceName ?? this.options.workspaceId,
      channelId,
      channelName,
      channelType,
      userId,
      username,
      editedMessageTs,
      newText: normalizedText,
      isFromSelf:
        (this.botUserId ? userId === this.botUserId : false) ||
        typeof message.bot_id === "string",
    };
  }

  private async normalizeIncomingText(text: string): Promise<string> {
    let content = decodeSlackEntities(text);

    const userMatches = Array.from(content.matchAll(/<@([A-Z0-9]+)>/g), (match) => match[1]);
    for (const userId of new Set(userMatches)) {
      const displayName = await this.getUserDisplayName(userId);
      content = content.replaceAll(`<@${userId}>`, `@${displayName}`);
    }

    content = content.replace(/<#([A-Z0-9]+)\|([^>]+)>/g, "#$2");
    content = content.replace(/<(https?:\/\/[^>|]+)\|[^>]+>/g, "$1");
    content = content.replace(/<(https?:\/\/[^>]+)>/g, "$1");

    return content;
  }

  private async getUserDisplayName(userId: string): Promise<string> {
    const cached = this.userDisplayNameCache.get(userId);
    if (cached) {
      return cached;
    }

    try {
      const response = await this.app.client.users.info({
        user: userId,
        token: this.options.botToken,
      });
      const user = response.user as Record<string, unknown> | undefined;
      const profile = user?.profile as Record<string, unknown> | undefined;
      const displayName =
        (typeof profile?.display_name === "string" && profile.display_name) ||
        (typeof profile?.real_name === "string" && profile.real_name) ||
        (typeof user?.name === "string" && user.name) ||
        userId;

      this.userDisplayNameCache.set(userId, displayName);
      return displayName;
    } catch {
      this.userDisplayNameCache.set(userId, userId);
      return userId;
    }
  }

  private async getChannelName(channelId: string): Promise<string> {
    const cached = this.channelNameCache.get(channelId);
    if (cached) {
      return cached;
    }

    try {
      const response = await this.app.client.conversations.info({
        channel: channelId,
        token: this.options.botToken,
      });
      const channel = response.channel as Record<string, unknown> | undefined;
      const channelName = (typeof channel?.name === "string" && channel.name) || channelId;

      this.channelNameCache.set(channelId, channelName);
      return channelName;
    } catch {
      this.channelNameCache.set(channelId, channelId);
      return channelId;
    }
  }
}

function normalizeName(name: string): string {
  return name.trim().split(/\s+/u).join("_");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function decodeSlackEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}
