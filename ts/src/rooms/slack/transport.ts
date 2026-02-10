import { App } from "@slack/bolt";

import type {
  SlackEventSource,
  SlackMessageEvent,
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
  private readonly queue = new AsyncQueue<SlackMessageEvent | null>();
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
      const mapped = await this.mapMessage(event as unknown as Record<string, unknown>);
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

  async receiveEvent(): Promise<SlackMessageEvent | null> {
    return await this.queue.shift();
  }

  async sendMessage(channelId: string, message: string): Promise<void> {
    await this.app.client.chat.postMessage({
      channel: channelId,
      text: message,
      token: this.options.botToken,
    });
  }

  private async mapMessage(event: Record<string, unknown>): Promise<SlackMessageEvent | null> {
    if (typeof event.subtype === "string") {
      return null;
    }

    const text = typeof event.text === "string" ? event.text : "";
    const channelId = typeof event.channel === "string" ? event.channel : "";
    const userId = typeof event.user === "string" ? event.user : "";

    if (!text || !channelId || !userId) {
      return null;
    }

    const isDirectMessage = channelId.startsWith("D");
    const mentionsBot = this.botUserId ? text.includes(`<@${this.botUserId}>`) : false;
    const username = await this.getUserDisplayName(userId);

    let channelName: string;
    if (isDirectMessage) {
      channelName = `${normalizeName(username)}_${userId}`;
    } else {
      const name = await this.getChannelName(channelId);
      channelName = `#${name}`;
    }

    return {
      workspaceId: this.options.workspaceId,
      workspaceName: this.options.workspaceName ?? this.options.workspaceId,
      channelId,
      channelName,
      userId,
      username,
      text,
      mynick: this.botDisplayName ?? this.options.botNameFallback ?? "muaddib",
      messageTs: typeof event.ts === "string" ? event.ts : undefined,
      isDirectMessage,
      mentionsBot,
    };
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
