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

  constructor(private readonly options: SlackSocketTransportOptions) {
    this.app = new App({
      token: options.botToken,
      appToken: options.appToken,
      socketMode: true,
    });

    this.app.event("message", async ({ event }) => {
      const mapped = this.mapMessage(event as unknown as Record<string, unknown>);
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

  private mapMessage(event: Record<string, unknown>): SlackMessageEvent | null {
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

    return {
      workspaceId: this.options.workspaceId,
      channelId,
      username: userId,
      text,
      mynick: this.options.botNameFallback ?? "muaddib",
      isDirectMessage,
      mentionsBot,
    };
  }
}
