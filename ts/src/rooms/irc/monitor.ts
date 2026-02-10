import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import type { RoomMessage } from "../message.js";
import type { RoomCommandHandlerTs } from "../command/command-handler.js";
import { VarlinkClient, VarlinkSender } from "./varlink.js";

export interface IrcMonitorRoomConfig {
  varlink: {
    socket_path: string;
  };
}

export interface IrcEvent {
  type?: string;
  subtype?: string;
  server?: string;
  target?: string;
  nick?: string;
  message?: string;
}

export interface IrcSender {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(target: string, message: string, server: string): Promise<boolean>;
  getServerNick(server: string): Promise<string | null>;
}

export interface IrcEventsClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  waitForEvents(): Promise<void>;
  receiveResponse(): Promise<Record<string, unknown> | null>;
}

interface CommandLike {
  shouldIgnoreUser(nick: string): boolean;
  handleIncomingMessage(
    message: RoomMessage,
    options: { isDirect: boolean; sendResponse?: (text: string) => Promise<void> },
  ): Promise<{ response: string | null } | null>;
}

export interface IrcRoomMonitorOptions {
  roomConfig: IrcMonitorRoomConfig;
  history: ChatHistoryStore;
  commandHandler: CommandLike;
  varlinkEvents?: IrcEventsClient;
  varlinkSender?: IrcSender;
  responseCleaner?: (text: string, nick: string) => string;
}

export class IrcRoomMonitor {
  private readonly varlinkEvents: IrcEventsClient;
  private readonly varlinkSender: IrcSender;
  private readonly responseCleaner: (text: string, nick: string) => string;
  private readonly serverNicks = new Map<string, string>();

  constructor(private readonly options: IrcRoomMonitorOptions) {
    this.varlinkEvents =
      options.varlinkEvents ?? new VarlinkClient(options.roomConfig.varlink.socket_path);
    this.varlinkSender =
      options.varlinkSender ?? new VarlinkSender(options.roomConfig.varlink.socket_path);
    this.responseCleaner = options.responseCleaner ?? defaultResponseCleaner;
  }

  async run(): Promise<void> {
    if (!(await this.connectWithRetry())) {
      return;
    }

    while (true) {
      const response = await this.varlinkEvents.receiveResponse();
      if (response === null) {
        await this.varlinkEvents.disconnect();
        await this.varlinkSender.disconnect();

        if (await this.connectWithRetry()) {
          continue;
        }

        break;
      }

      const parameters = (response.parameters as Record<string, unknown> | undefined) ?? {};
      const event = parameters.event as IrcEvent | undefined;
      if (event) {
        try {
          await this.processMessageEvent(event);
        } catch (error) {
          console.error("IRC monitor failed to process event; continuing", error);
        }
      }

      if (response.error) {
        break;
      }
    }

    await this.varlinkEvents.disconnect();
    await this.varlinkSender.disconnect();
  }

  async processMessageEvent(event: IrcEvent): Promise<void> {
    if (event.type !== "message") {
      return;
    }

    if (!event.server || !event.target || !event.nick || !event.message) {
      return;
    }

    const server = event.server;
    const target = event.target;
    const nick = event.nick;
    const message = event.message;

    const channelName = event.subtype === "public" ? target : nick;

    const mynick = await this.getMynick(server);
    if (!mynick) {
      return;
    }

    const [normalizedNick, normalizedMessage] = normalizeSenderAndMessage(nick, message);

    if (
      this.options.commandHandler.shouldIgnoreUser(nick) ||
      this.options.commandHandler.shouldIgnoreUser(normalizedNick)
    ) {
      return;
    }

    const inputMatch = inputMatchForMynick(mynick, normalizedMessage);
    const isPrivate = event.subtype !== "public";
    const isDirect = Boolean(inputMatch) || isPrivate;

    const effectiveNick = inputMatch?.groups?.nick ?? normalizedNick;
    const cleanedMessage = inputMatch?.groups?.content ?? normalizedMessage;

    const roomMessage: RoomMessage = {
      serverTag: server,
      channelName,
      nick: effectiveNick,
      mynick,
      content: isDirect ? cleanedMessage : normalizedMessage,
    };

    await this.options.commandHandler.handleIncomingMessage(roomMessage, {
      isDirect,
      sendResponse: async (text) => {
        const responseText = this.responseCleaner(text, roomMessage.nick);
        await this.varlinkSender.sendMessage(channelName, responseText, server);
      },
    });
  }

  private async connectWithRetry(maxRetries = 5): Promise<boolean> {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        await this.varlinkEvents.connect();
        await this.varlinkSender.connect();
        await this.varlinkEvents.waitForEvents();
        return true;
      } catch {
        if (attempt >= maxRetries - 1) {
          return false;
        }

        const waitMs = 2 ** attempt * 1000;
        await sleep(waitMs);
      }
    }

    return false;
  }

  private async getMynick(server: string): Promise<string | null> {
    const cached = this.serverNicks.get(server);
    if (cached) {
      return cached;
    }

    const nick = await this.varlinkSender.getServerNick(server);
    if (nick) {
      this.serverNicks.set(server, nick);
    }
    return nick;
  }
}

export function createIrcCommandHandlerOptions(commandHandler: RoomCommandHandlerTs): CommandLike {
  return commandHandler;
}

function inputMatchForMynick(mynick: string, message: string): RegExpMatchArray | null {
  const pattern = new RegExp(`^\\s*(?<nick><?.*?>\\s*)?${escapeRegExp(mynick)}[,:]\\s*(?<content>.*)$`, "i");
  return message.match(pattern);
}

function normalizeSenderAndMessage(nick: string, message: string): [string, string] {
  const lowered = nick.toLowerCase();
  if (!lowered.includes("bot") && !lowered.includes("bridge")) {
    return [nick, message];
  }

  const match = message.match(/^\s*<([^>\n]+)>\s*(.*)$/s);
  if (!match) {
    return [nick, message];
  }

  const bridgedNick = match[1].trim();
  const bridgedContent = match[2].trim();
  if (!bridgedNick || !bridgedContent) {
    return [nick, message];
  }

  return [bridgedNick, bridgedContent];
}

function defaultResponseCleaner(text: string): string {
  const cleaned = text.replace(/\n/g, "; ").trim();
  return cleaned || text;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
