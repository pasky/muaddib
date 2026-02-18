import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import type { RoomConfig } from "../../config/muaddib-config.js";
import { CONSOLE_LOGGER, RuntimeLogWriter, type Logger } from "../../app/logging.js";
import { appendAttachmentBlock, normalizeName, nowMonotonicSeconds, requireNonEmptyString, sleep, stripLeadingMention } from "../../utils/index.js";
import type { MuaddibRuntime } from "../../runtime.js";
import { RoomMessageHandler } from "../command/message-handler.js";
import { type RoomMessage, roomArc } from "../message.js";
import {
  sendWithRetryResult,
  type SendRetryEvent,
  createSendRetryEventLogger,
} from "../send-retry.js";
import { SlackSocketTransport } from "./transport.js";

interface CommandLike {
  handleIncomingMessage(
    message: RoomMessage,
    options: { isDirect: boolean; sendResponse?: (text: string) => Promise<void> },
  ): Promise<{ response: string | null } | null>;
  cancelProactive?(): void;
}

export interface SlackFileAttachment {
  mimetype?: string;
  filetype?: string;
  name?: string;
  title?: string;
  size?: number;
  urlPrivate?: string;
  urlPrivateDownload?: string;
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
  files?: SlackFileAttachment[];
  secrets?: Record<string, unknown>;
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

export interface SlackSendResult {
  messageTs?: string;
  text?: string;
}

export interface SlackSender {
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  sendMessage(
    channelId: string,
    message: string,
    options?: SlackSendOptions,
  ): Promise<SlackSendResult | void>;
  updateMessage?(
    channelId: string,
    messageTs: string,
    message: string,
  ): Promise<SlackSendResult | void>;
  formatOutgoingMentions?(message: string): Promise<string>;
  setTypingIndicator?(channelId: string, threadTs: string): Promise<boolean>;
  clearTypingIndicator?(channelId: string, threadTs: string): Promise<void>;
}

export interface SlackRoomMonitorOptions {
  roomConfig: RoomConfig;
  ignoreUsers?: string[];
  history: ChatHistoryStore;
  commandHandler: CommandLike;
  eventSource?: SlackEventSource;
  sender?: SlackSender;
  onSendRetryEvent?: (event: SendRetryEvent) => void;
  logger?: Logger;
  logWriter?: RuntimeLogWriter;
}

export class SlackRoomMonitor {
  private readonly logger: Logger;
  private readonly logWriter?: RuntimeLogWriter;

  static async fromRuntime(runtime: MuaddibRuntime): Promise<SlackRoomMonitor[]> {
    const roomConfig = runtime.config.getRoomConfig("slack");
    const enabled = roomConfig.enabled ?? false;
    if (!enabled) {
      return [];
    }

    const appToken = requireNonEmptyString(
      await runtime.authStorage.getApiKey("slack-app"),
      "Slack room is enabled but 'slack-app' API key is missing from auth.json.",
    );

    const workspaceEntries = Object.entries(roomConfig.workspaces ?? {});
    if (workspaceEntries.length === 0) {
      throw new Error("Slack room is enabled but rooms.slack.workspaces is missing.");
    }

    const commandHandler = new RoomMessageHandler(runtime, "slack");

    return await Promise.all(workspaceEntries.map(async ([workspaceId, workspaceConfig]) => {
      const botToken = requireNonEmptyString(
        await runtime.authStorage.getApiKey(`slack-${workspaceId}`),
        `Slack room is enabled but 'slack-${workspaceId}' API key is missing from auth.json.`,
      );

      const transport = new SlackSocketTransport({
        appToken,
        botToken,
        workspaceId,
        workspaceName: workspaceConfig.name,
        botNameFallback: workspaceConfig.name,
      });

      return new SlackRoomMonitor({
        roomConfig,
        ignoreUsers: roomConfig.command?.ignoreUsers?.map(String),
        history: runtime.history,
        commandHandler,
        eventSource: transport,
        sender: transport,
        onSendRetryEvent: createSendRetryEventLogger(
          runtime.logger.getLogger(`muaddib.send-retry.slack.${workspaceId}`),
        ),
        logger: runtime.logger.getLogger(`muaddib.rooms.slack.monitor.${workspaceId}`),
        logWriter: runtime.logger,
      });
    }));
  }

  constructor(private readonly options: SlackRoomMonitorOptions) {
    this.logger = options.logger ?? CONSOLE_LOGGER;
    this.logWriter = options.logWriter;
  }

  async run(): Promise<void> {
    if (!this.options.eventSource) {
      this.logger.warn("Slack monitor has no event source; skipping run.");
      return;
    }

    const senderIsEventSource = Object.is(this.options.sender, this.options.eventSource);
    const reconnect = this.options.roomConfig.reconnect;

    this.logger.info("Slack monitor starting.");

    let reconnectAttempts = 0;

    try {
      while (true) {
        let eventSourceConnected = false;
        let senderConnected = false;

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
              this.logger.info(
                "Slack monitor received null event (graceful shutdown signal); stopping without reconnect.",
              );
              return;
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
        } catch (error) {
          if (!(reconnect?.enabled ?? false)) {
            throw error;
          }

          reconnectAttempts += 1;
          if (reconnectAttempts > (reconnect?.maxAttempts ?? 5)) {
            throw error;
          }

          this.logger.warn(
            "Slack monitor receive loop failed; reconnecting",
            `attempt=${reconnectAttempts}`,
            `delay_ms=${(reconnect?.delayMs ?? 1_000)}`,
            error,
          );
        } finally {
          if (this.options.sender && !senderIsEventSource && senderConnected && this.options.sender.disconnect) {
            await this.options.sender.disconnect();
          }

          if (eventSourceConnected && this.options.eventSource.disconnect) {
            await this.options.eventSource.disconnect();
          }
        }

        await sleep((reconnect?.delayMs ?? 1_000));
      }
    } finally {
      this.options.commandHandler.cancelProactive?.();
      this.logger.info("Slack monitor stopped.");
    }
  }

  async processMessageEvent(event: SlackMessageEvent): Promise<void> {
    if (!event.workspaceId || !event.channelId || !event.username || !event.mynick) {
      return;
    }

    const files = event.files ?? [];
    if (!event.text && files.length === 0) {
      return;
    }

    if (event.isFromSelf) {
      return;
    }

    const ignoreUsers = this.options.ignoreUsers ?? [];
    if (ignoreUsers.some((u) => u.toLowerCase() === event.username.toLowerCase())) {
      return;
    }

    const isDirect = Boolean(event.isDirectMessage || event.mentionsBot);
    const textContent = isDirect
      ? normalizeDirectContent(event.text, event.mynick, event.botUserId)
      : event.text.trim();
    const attachmentBlock = buildSlackAttachmentBlock(files);
    const cleanedContent = appendAttachmentBlock(textContent, attachmentBlock);

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
      secrets: event.secrets,
    };

    const sender = this.options.sender;
    const replyEditDebounceSeconds = this.options.roomConfig.replyEditDebounceSeconds ?? 15;
    let lastReplyTs: string | undefined;
    let lastReplyText: string | undefined;
    let lastReplyAtSeconds: number | undefined;
    let typingIndicatorThreadTs: string | undefined;

    const handleIncoming = async (): Promise<void> => {
      await this.options.commandHandler.handleIncomingMessage(message, {
        isDirect,
        sendResponse: sender
          ? async (text) => {
              const formattedText = sender.formatOutgoingMentions
                ? await sender.formatOutgoingMentions(text)
                : text;
              const nowSeconds = nowMonotonicSeconds();

              if (
                sender.updateMessage &&
                lastReplyTs &&
                lastReplyAtSeconds !== undefined &&
                nowSeconds - lastReplyAtSeconds < replyEditDebounceSeconds
              ) {
                const combined = lastReplyText ? `${lastReplyText}\n${formattedText}` : formattedText;
                const targetMessageTs = lastReplyTs;

                const updateResult = await sendWithRetryResult<SlackSendResult>(
                  event.channelId,
                  "slack",
                  this.options.onSendRetryEvent,
                  async () => await sender.updateMessage!(event.channelId, targetMessageTs, combined),
                );

                if (updateResult?.messageTs) {
                  lastReplyTs = updateResult.messageTs;
                }
                lastReplyText = combined;
                lastReplyAtSeconds = nowSeconds;
              } else {
                const sendResult = await sendWithRetryResult<SlackSendResult>(
                  event.channelId,
                  "slack",
                  this.options.onSendRetryEvent,
                  async () =>
                    await sender.sendMessage(event.channelId, formattedText, {
                      threadTs: responseThreadId,
                    }),
                );

                if (sendResult?.messageTs) {
                  lastReplyTs = sendResult.messageTs;
                }
                lastReplyText = formattedText;
                lastReplyAtSeconds = nowSeconds;
              }

              if (typingIndicatorThreadTs && sender.setTypingIndicator) {
                await sender.setTypingIndicator(event.channelId, typingIndicatorThreadTs);
              }
            }
          : undefined,
      });
    };

    if (!isDirect) {
      await handleIncoming();
      return;
    }

    const arc = roomArc(message);
    const typingThreadTs = message.threadId ?? event.messageTs;
    let typingIndicatorSet = false;

    if (sender?.setTypingIndicator && typingThreadTs) {
      typingIndicatorSet = await sender.setTypingIndicator(event.channelId, typingThreadTs);
      if (typingIndicatorSet) {
        typingIndicatorThreadTs = typingThreadTs;
      }
    }

    const runDirectMessage = async (): Promise<void> => {
      this.logger.debug("Processing direct Slack message", `arc=${arc}`, `nick=${message.nick}`);
      try {
        await handleIncoming();
      } finally {
        if (typingIndicatorSet && typingThreadTs && sender?.clearTypingIndicator) {
          await sender.clearTypingIndicator(event.channelId, typingThreadTs);
        }
      }
    };

    if (this.logWriter) {
      await this.logWriter.withMessageContext({ arc, nick: message.nick, message: message.content }, runDirectMessage);
    } else {
      await runDirectMessage();
    }
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

function buildSlackAttachmentBlock(files: SlackFileAttachment[]): string {
  if (files.length === 0) {
    return "";
  }

  const lines = files
    .map((file, index) => {
      let meta = file.mimetype || file.filetype || "attachment";
      const filename = file.name || file.title;
      if (filename) {
        meta += ` (filename: ${filename})`;
      }
      if (file.size) {
        meta += ` (size: ${file.size})`;
      }

      const url = file.urlPrivate || file.urlPrivateDownload || "";
      return `${index + 1}. ${meta}: ${url}`;
    })
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return "";
  }

  return ["[Attachments]", ...lines, "[/Attachments]"].join("\n");
}

function resolveReplyThreadTs(
  roomConfig: RoomConfig,
  event: Pick<SlackMessageEvent, "threadTs" | "messageTs" | "channelType" | "isDirectMessage">,
): string | undefined {
  if (event.threadTs) {
    return event.threadTs;
  }

  if (!event.messageTs) {
    return undefined;
  }

  const replyStartThread = roomConfig.replyStartThread;
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
  return stripLeadingMention(content, mynick, botUserId);
}
