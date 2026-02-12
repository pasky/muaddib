import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type PartialMessage,
} from "discord.js";

import type {
  DiscordEventSource,
  DiscordAttachment,
  DiscordIncomingEvent,
  DiscordMessageEditEvent,
  DiscordMessageEvent,
  DiscordSendOptions,
  DiscordSendResult,
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

interface DiscordTransportSignal {
  kind: "disconnect";
  reason: string;
}

export interface DiscordTransportOptions {
  token: string;
  botNameFallback?: string;
}

/**
 * Real Discord gateway transport behind monitor abstractions.
 */
export class DiscordGatewayTransport implements DiscordEventSource, DiscordSender {
  private readonly queue = new AsyncQueue<DiscordIncomingEvent | DiscordTransportSignal | null>();
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

    this.client.on("messageUpdate", async (_before, after) => {
      const resolved = await this.resolveMessage(after);
      if (!resolved) {
        return;
      }

      const mapped = this.mapMessageEdit(resolved);
      if (mapped) {
        this.queue.push(mapped);
      }
    });

    this.client.on("error", (error) => {
      this.queue.push({
        kind: "disconnect",
        reason: error?.message ?? "discord client error",
      });
    });

    this.client.on("shardDisconnect", (event) => {
      this.queue.push({
        kind: "disconnect",
        reason: event?.reason ?? "discord shard disconnect",
      });
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

  async receiveEvent(): Promise<DiscordIncomingEvent | null> {
    const next = await this.queue.shift();
    if (isDiscordTransportSignal(next)) {
      throw new Error(`Discord gateway disconnected: ${next.reason}`);
    }
    return next;
  }

  async sendMessage(
    channelId: string,
    message: string,
    options?: DiscordSendOptions,
  ): Promise<DiscordSendResult> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel '${channelId}' is not text-based.`);
    }

    if (!("send" in channel) || typeof channel.send !== "function") {
      throw new Error(`Discord channel '${channelId}' does not support send().`);
    }

    const payload = options?.replyToMessageId
      ? {
          content: message,
          reply: {
            messageReference: options.replyToMessageId,
            failIfNotExists: false,
          },
          allowedMentions: {
            repliedUser: options.mentionAuthor ?? false,
          },
        }
      : message;

    const sent = await channel.send(payload as any);

    return {
      messageId: typeof sent?.id === "string" ? sent.id : undefined,
      content: typeof sent?.content === "string" ? sent.content : message,
    };
  }

  async editMessage(channelId: string, messageId: string, message: string): Promise<DiscordSendResult> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel '${channelId}' is not text-based.`);
    }

    if (!("messages" in channel) || typeof channel.messages?.fetch !== "function") {
      throw new Error(`Discord channel '${channelId}' does not support message edits.`);
    }

    const targetMessage = await channel.messages.fetch(messageId);
    if (!targetMessage || typeof (targetMessage as Message).edit !== "function") {
      throw new Error(`Discord message '${messageId}' could not be loaded for edit.`);
    }

    const edited = await targetMessage.edit({ content: message });

    return {
      messageId: typeof edited?.id === "string" ? edited.id : messageId,
      content: typeof edited?.content === "string" ? edited.content : message,
    };
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

    const username =
      message.member?.displayName ?? message.author.displayName ?? message.author.username;

    let channelName: string | undefined;
    let threadId: string | undefined;

    if (isDirectMessage) {
      channelName = `${normalizeName(username)}_${message.author.id}`;
    } else if (isThreadChannel(message.channel)) {
      threadId = message.channel.id;
      const parentName = typeof message.channel.parent?.name === "string" ? message.channel.parent.name : "";
      channelName = normalizeName(parentName || message.channel.name);
    } else {
      const rawChannelName = "name" in message.channel ? String(message.channel.name ?? "") : "";
      channelName = normalizeName(rawChannelName);
    }

    return {
      kind: "message",
      guildId: message.guildId ?? undefined,
      guildName: message.guild?.name,
      channelId: message.channelId,
      channelName,
      messageId: message.id,
      threadId,
      username,
      content: normalizeDiscordContent(message.cleanContent || message.content),
      mynick,
      attachments: mapDiscordAttachments(message.attachments),
      botUserId: this.client.user?.id,
      isDirectMessage,
      mentionsBot,
      isFromSelf: this.client.user ? message.author.id === this.client.user.id : false,
    };
  }

  private mapMessageEdit(message: Message): DiscordMessageEditEvent | null {
    if (!message.id || !message.channelId) {
      return null;
    }

    const content = normalizeDiscordContent(message.cleanContent || message.content || "").trim();
    if (!content) {
      return null;
    }

    const username =
      message.member?.displayName ?? message.author.displayName ?? message.author.username;

    let channelName: string | undefined;
    if (message.guildId === null) {
      channelName = `${normalizeName(username)}_${message.author.id}`;
    } else if (isThreadChannel(message.channel)) {
      const parentName = typeof message.channel.parent?.name === "string" ? message.channel.parent.name : "";
      channelName = normalizeName(parentName || message.channel.name);
    } else {
      const rawChannelName = "name" in message.channel ? String(message.channel.name ?? "") : "";
      channelName = normalizeName(rawChannelName);
    }

    return {
      kind: "message_edit",
      guildId: message.guildId ?? undefined,
      guildName: message.guild?.name,
      channelId: message.channelId,
      channelName,
      messageId: message.id,
      username,
      content,
      isFromSelf: this.client.user ? message.author.id === this.client.user.id : false,
    };
  }

  private async resolveMessage(message: Message | PartialMessage): Promise<Message | null> {
    if (isFullMessage(message)) {
      return message;
    }

    if (!message.partial) {
      return null;
    }

    try {
      return await message.fetch();
    } catch {
      return null;
    }
  }
}

function normalizeDiscordContent(content: string): string {
  return content.replace(/<a?:([0-9A-Za-z_]+):\d+>/g, ":$1:");
}

function normalizeName(name: string): string {
  return name.trim().split(/\s+/u).join("_");
}

function isFullMessage(message: Message | PartialMessage): message is Message {
  return "author" in message && message.author !== null;
}

function isThreadChannel(channel: Message["channel"]): channel is Message["channel"] & { id: string; name: string; parent?: { name?: string | null } } {
  return typeof (channel as { isThread?: () => boolean }).isThread === "function" &&
    Boolean((channel as { isThread: () => boolean }).isThread());
}

function isDiscordTransportSignal(
  value: DiscordIncomingEvent | DiscordTransportSignal | null,
): value is DiscordTransportSignal {
  return Boolean(value && typeof value === "object" && "kind" in value && value.kind === "disconnect");
}

function mapDiscordAttachments(attachments: Message["attachments"]): DiscordAttachment[] {
  return Array.from(attachments.values()).map((attachment) => ({
    url: attachment.url,
    contentType: attachment.contentType ?? undefined,
    filename: attachment.name ?? undefined,
    size: attachment.size ?? undefined,
  }));
}
