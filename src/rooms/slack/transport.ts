import { App } from "@slack/bolt";

import { AsyncQueue } from "../../utils/async-queue.js";
import { escapeRegExp, stringifyError } from "../../utils/index.js";
import type {
  SlackEventSource,
  SlackFileAttachment,
  SlackIncomingEvent,
  SlackMessageEditEvent,
  SlackMessageEvent,
  SlackSendOptions,
  SlackSendResult,
  SlackSender,
} from "./monitor.js";


interface SlackTransportSignal {
  kind: "disconnect";
  reason: string;
}

export interface SlackSocketTransportOptions {
  appToken: string;
  botToken: string;
  workspaceId: string;
  workspaceName?: string;
  botNameFallback?: string;
}

const TYPING_LOADING_MESSAGES = [
  "Thinking...",
  "Consulting the spice...",
  "The worm is turning...",
  "Prescience loading...",
];

/**
 * Real Slack socket-mode transport behind monitor abstractions.
 */
export class SlackSocketTransport implements SlackEventSource, SlackSender {
  private readonly queue = new AsyncQueue<SlackIncomingEvent | SlackTransportSignal | null>();
  private app: App | null = null;
  private connected = false;
  private botUserId: string | null = null;
  private botDisplayName: string | null = null;
  private readonly userDisplayNameCache = new Map<string, string>();
  private readonly userIdByDisplayNameCache = new Map<string, string>();
  private readonly channelNameCache = new Map<string, string>();

  constructor(private readonly options: SlackSocketTransportOptions) {}

  private getApp(): App {
    if (!this.app) {
      throw new Error("SlackSocketTransport not connected");
    }
    return this.app;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.app = new App({
      token: this.options.botToken,
      appToken: this.options.appToken,
      socketMode: true,
    });

    this.app.event("message", async ({ event }) => {
      const mapped = await this.mapEvent(event as unknown as Record<string, unknown>);
      if (mapped) {
        this.queue.push(mapped);
      }
    });

    this.app.error(async (error) => {
      this.queue.push({
        kind: "disconnect",
        reason: stringifyError(error),
      });
    });

    await this.app.start();
    this.connected = true;

    const auth = await this.getApp().client.auth.test({
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
    await this.getApp().stop();
    this.queue.push(null);
  }

  async receiveEvent(): Promise<SlackIncomingEvent | null> {
    const next = await this.queue.shift();
    if (isSlackTransportSignal(next)) {
      throw new Error(`Slack socket disconnected: ${next.reason}`);
    }
    return next;
  }

  async sendMessage(
    channelId: string,
    message: string,
    options?: SlackSendOptions,
  ): Promise<SlackSendResult> {
    const response = await this.getApp().client.chat.postMessage({
      channel: channelId,
      text: message,
      thread_ts: options?.threadTs,
      token: this.options.botToken,
    });

    return {
      messageTs: typeof response.ts === "string" ? response.ts : undefined,
      text: message,
    };
  }

  async updateMessage(
    channelId: string,
    messageTs: string,
    message: string,
  ): Promise<SlackSendResult> {
    const response = await this.getApp().client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: message,
      token: this.options.botToken,
    });

    return {
      messageTs: typeof response.ts === "string" ? response.ts : messageTs,
      text: message,
    };
  }

  async formatOutgoingMentions(message: string): Promise<string> {
    if (!message) {
      return message;
    }

    if (this.userIdByDisplayNameCache.size === 0) {
      return message;
    }

    const sortedDisplayNames = Array.from(this.userIdByDisplayNameCache.keys()).sort(
      (left, right) => right.length - left.length,
    );

    let result = message;

    for (const displayNameKey of sortedDisplayNames) {
      const userId = this.userIdByDisplayNameCache.get(displayNameKey);
      if (!userId) {
        continue;
      }

      const pattern = new RegExp(`@${escapeRegExp(displayNameKey)}`, "giu");
      result = result.replace(pattern, `<@${userId}>`);
    }

    return result;
  }

  async setTypingIndicator(channelId: string, threadTs: string): Promise<boolean> {
    if (!threadTs) {
      return false;
    }

    try {
      await this.getApp().client.apiCall("assistant.threads.setStatus", {
        channel_id: channelId,
        thread_ts: threadTs,
        status: "is thinking...",
        loading_messages: TYPING_LOADING_MESSAGES,
        token: this.options.botToken,
      });
      return true;
    } catch (error) {
      const errorCode = slackErrorCode(error);
      if (errorCode === "missing_scope" || errorCode === "thread_not_found") {
        return false;
      }
      return false;
    }
  }

  async clearTypingIndicator(channelId: string, threadTs: string): Promise<void> {
    if (!threadTs) {
      return;
    }

    try {
      await this.getApp().client.apiCall("assistant.threads.setStatus", {
        channel_id: channelId,
        thread_ts: threadTs,
        status: "",
        token: this.options.botToken,
      });
    } catch {
      // Best effort cleanup.
    }
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
    const files = mapSlackFiles(event.files);

    if (!channelId || !userId || (!rawText && files.length === 0)) {
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
      files,
      secrets: buildSlackFileSecrets(files, this.options.botToken),
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
      this.userIdByDisplayNameCache.set(cached.toLowerCase(), userId);
      return cached;
    }

    try {
      const response = await this.getApp().client.users.info({
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
      this.userIdByDisplayNameCache.set(displayName.toLowerCase(), userId);
      return displayName;
    } catch {
      this.userDisplayNameCache.set(userId, userId);
      this.userIdByDisplayNameCache.set(userId.toLowerCase(), userId);
      return userId;
    }
  }

  private async getChannelName(channelId: string): Promise<string> {
    const cached = this.channelNameCache.get(channelId);
    if (cached) {
      return cached;
    }

    try {
      const response = await this.getApp().client.conversations.info({
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

function mapSlackFiles(value: unknown): SlackFileAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      mimetype: typeof entry.mimetype === "string" ? entry.mimetype : undefined,
      filetype: typeof entry.filetype === "string" ? entry.filetype : undefined,
      name: typeof entry.name === "string" ? entry.name : undefined,
      title: typeof entry.title === "string" ? entry.title : undefined,
      size: typeof entry.size === "number" ? entry.size : undefined,
      urlPrivate: typeof entry.url_private === "string" ? entry.url_private : undefined,
      urlPrivateDownload:
        typeof entry.url_private_download === "string" ? entry.url_private_download : undefined,
    }));
}

function buildSlackFileSecrets(
  files: SlackFileAttachment[],
  botToken: string,
): Record<string, unknown> | undefined {
  if (files.length === 0) {
    return undefined;
  }

  const hasPrivateSlackUrl = files.some(
    (file) =>
      (file.urlPrivate && file.urlPrivate.startsWith("https://files.slack.com/")) ||
      (file.urlPrivateDownload && file.urlPrivateDownload.startsWith("https://files.slack.com/")),
  );

  if (!hasPrivateSlackUrl) {
    return undefined;
  }

  return {
    http_header_prefixes: {
      "https://files.slack.com/": {
        Authorization: `Bearer ${botToken}`,
      },
    },
  };
}

function isSlackTransportSignal(
  value: SlackIncomingEvent | SlackTransportSignal | null,
): value is SlackTransportSignal {
  return Boolean(value && typeof value === "object" && "kind" in value && value.kind === "disconnect");
}

function slackErrorCode(error: unknown): string {
  const record = asRecord(error);
  if (!record) {
    return "";
  }

  const direct = record.error;
  if (typeof direct === "string") {
    return direct;
  }

  const data = asRecord(record.data);
  if (data && typeof data.error === "string") {
    return data.error;
  }

  return "";
}
