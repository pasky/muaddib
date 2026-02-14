import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import { createConsoleLogger, type RuntimeLogger } from "../../app/logging.js";
import type { MuaddibRuntime } from "../../runtime.js";
import type { RoomMessage } from "../message.js";
import { RoomCommandHandlerTs } from "../command/command-handler.js";
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
  logger?: RuntimeLogger;
}

export class IrcRoomMonitor {
  private readonly varlinkEvents: IrcEventsClient;
  private readonly varlinkSender: IrcSender;
  private readonly responseCleaner: (text: string, nick: string) => string;
  private readonly logger: RuntimeLogger;
  private readonly serverNicks = new Map<string, string>();

  static fromRuntime(runtime: MuaddibRuntime): IrcRoomMonitor[] {
    const roomConfig = runtime.config.getRoomConfig("irc");
    const enabled = roomConfig.enabled ?? true;
    if (!enabled) {
      return [];
    }

    const socketPath = requireNonEmptyString(
      roomConfig.varlink?.socket_path,
      "IRC room is enabled but rooms.irc.varlink.socket_path is missing.",
    );

    const commandHandler = new RoomCommandHandlerTs(runtime, "irc", {
      responseCleaner: (text) => text.replace(/\n/g, "; ").trim(),
    });

    return [
      new IrcRoomMonitor({
        roomConfig: {
          varlink: {
            socket_path: socketPath,
          },
        },
        history: runtime.history,
        commandHandler,
        logger: runtime.logger.getLogger("muaddib.rooms.irc.monitor"),
      }),
    ];
  }

  constructor(private readonly options: IrcRoomMonitorOptions) {
    this.varlinkEvents =
      options.varlinkEvents ?? new VarlinkClient(options.roomConfig.varlink.socket_path);
    this.varlinkSender =
      options.varlinkSender ?? new VarlinkSender(options.roomConfig.varlink.socket_path);
    this.responseCleaner = options.responseCleaner ?? defaultResponseCleaner;
    this.logger = options.logger ?? createConsoleLogger("muaddib.rooms.irc.monitor");
  }

  async run(): Promise<void> {
    if (!(await this.connectWithRetry())) {
      this.logger.error("Could not establish varlink connection; exiting IRC monitor.");
      return;
    }

    this.logger.info("Muaddib started, waiting for IRC events...");

    const inFlightEvents = new Set<Promise<void>>();

    while (true) {
      const response = await this.varlinkEvents.receiveResponse();
      if (response === null) {
        this.logger.warn("IRC varlink connection lost; attempting reconnect.");
        await this.varlinkEvents.disconnect();
        await this.varlinkSender.disconnect();
        this.serverNicks.clear();

        if (await this.connectWithRetry()) {
          this.logger.info("IRC varlink reconnect succeeded.");
          continue;
        }

        this.logger.error("IRC varlink reconnect failed; exiting IRC monitor.");
        break;
      }

      const parameters = (response.parameters as Record<string, unknown> | undefined) ?? {};
      const event = parameters.event as IrcEvent | undefined;
      if (event) {
        const task = this.processMessageEvent(event)
          .catch((error) => {
            this.logger.error("IRC monitor failed to process event; continuing", error);
          })
          .finally(() => {
            inFlightEvents.delete(task);
          });

        inFlightEvents.add(task);
      }

      if (response.error) {
        this.logger.error("IRC monitor received varlink error response", response.error);
        break;
      }
    }

    if (inFlightEvents.size > 0) {
      await Promise.allSettled([...inFlightEvents]);
    }

    await this.varlinkEvents.disconnect();
    await this.varlinkSender.disconnect();
    this.logger.info("IRC monitor stopped.");
  }

  async processMessageEvent(event: IrcEvent): Promise<void> {
    this.logger.debug("Processing message event", event);

    if (event.type !== "message") {
      return;
    }

    if (!event.server || !event.target || !event.nick || !event.message) {
      this.logger.debug("Skipping invalid message event", event);
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
    if (normalizedNick !== nick) {
      this.logger.debug("Normalized bridged IRC sender", `from=${nick}`, `to=${normalizedNick}`);
    }

    if (
      this.options.commandHandler.shouldIgnoreUser(nick) ||
      this.options.commandHandler.shouldIgnoreUser(normalizedNick)
    ) {
      this.logger.debug("Ignoring user", `nick=${nick}`, `normalized=${normalizedNick}`);
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

    const handleIncoming = async (): Promise<void> => {
      await this.options.commandHandler.handleIncomingMessage(roomMessage, {
        isDirect,
        sendResponse: async (text) => {
          const responseText = this.responseCleaner(text, roomMessage.nick);
          await this.varlinkSender.sendMessage(channelName, responseText, server);
        },
      });
    };

    if (!isDirect) {
      await handleIncoming();
      return;
    }

    const arc = `${server}#${channelName}`;
    await this.logger.withMessageContext(
      {
        arc,
        nick: effectiveNick,
        message: normalizedMessage,
      },
      async () => {
        this.logger.debug("Processing direct IRC message", `arc=${arc}`, `nick=${effectiveNick}`);
        await handleIncoming();
      },
    );
  }

  private async connectWithRetry(maxRetries = 5): Promise<boolean> {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        await this.varlinkEvents.connect();
        await this.varlinkSender.connect();
        await this.varlinkEvents.waitForEvents();
        this.logger.info("Successfully connected to varlink sockets.");
        return true;
      } catch (error) {
        this.logger.warn(`Connection attempt ${attempt + 1} failed.`, error);
        await Promise.allSettled([
          this.varlinkEvents.disconnect(),
          this.varlinkSender.disconnect(),
        ]);
        this.serverNicks.clear();

        if (attempt >= maxRetries - 1) {
          this.logger.error(`Failed to connect after ${maxRetries} attempts.`);
          return false;
        }

        const waitMs = 2 ** attempt * 1000;
        this.logger.info(`Retrying in ${waitMs / 1000} seconds...`);
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

    try {
      const nick = await this.varlinkSender.getServerNick(server);
      if (nick) {
        this.serverNicks.set(server, nick);
        this.logger.debug("Got nick for server", `server=${server}`, `nick=${nick}`);
      }
      return nick;
    } catch (error) {
      this.logger.error("Failed to get nick for server", `server=${server}`, error);
      return null;
    }
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

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}
