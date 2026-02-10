import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";

import type {
  DiscordEventSource,
  DiscordMessageEvent,
  DiscordSender,
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

export interface DiscordTransportOptions {
  token: string;
  botNameFallback?: string;
}

/**
 * Real Discord gateway transport behind monitor abstractions.
 */
export class DiscordGatewayTransport implements DiscordEventSource, DiscordSender {
  private readonly queue = new AsyncQueue<DiscordMessageEvent | null>();
  private readonly client: Client;
  private connected = false;

  constructor(private readonly options: DiscordTransportOptions) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    this.client.on("messageCreate", async (message) => {
      const mapped = this.mapMessage(message);
      if (mapped) {
        this.queue.push(mapped);
      }
    });

    this.client.on("error", () => {
      this.queue.push(null);
    });

    this.client.on("shardDisconnect", () => {
      this.queue.push(null);
    });
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    await this.client.login(this.options.token);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    this.connected = false;
    this.client.destroy();
    this.queue.push(null);
  }

  async receiveEvent(): Promise<DiscordMessageEvent | null> {
    return await this.queue.shift();
  }

  async sendMessage(channelId: string, message: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel '${channelId}' is not text-based.`);
    }

    if (!("send" in channel) || typeof channel.send !== "function") {
      throw new Error(`Discord channel '${channelId}' does not support send().`);
    }

    await channel.send(message);
  }

  private mapMessage(message: Message): DiscordMessageEvent | null {
    if (message.author.bot) {
      return null;
    }

    const mynick = this.client.user?.username ?? this.options.botNameFallback ?? "muaddib";
    const mentionsBot = this.client.user ? message.mentions.has(this.client.user.id) : false;

    const isDirectMessage =
      message.channel.type === ChannelType.DM ||
      message.channel.type === ChannelType.GroupDM ||
      message.guildId === null;

    const channelName = "name" in message.channel ? String(message.channel.name ?? "") : undefined;

    return {
      guildId: message.guildId ?? undefined,
      channelId: message.channelId,
      channelName,
      username: message.author.username,
      content: message.content,
      mynick,
      isDirectMessage,
      mentionsBot,
    };
  }
}
