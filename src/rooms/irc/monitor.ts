import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import type { RoomConfig } from "../../config/muaddib-config.js";
import { CONSOLE_LOGGER, RuntimeLogWriter, type Logger } from "../../app/logging.js";
import { escapeRegExp, requireNonEmptyString, sleep } from "../../utils/index.js";
import type { MuaddibRuntime } from "../../runtime.js";
import { RoomMessageHandler } from "../command/message-handler.js";
import { InFlightTaskSet } from "../in-flight-task-set.js";
import { buildArc, matchIrcAllowlist, type RoomMessage } from "../message.js";
import type { RoomGateway } from "../room-gateway.js";
import { VarlinkClient, VarlinkSender } from "./varlink.js";
import type { ArcEventsWatcher } from "../../events/watcher.js";

export interface IrcEvent {
  type?: string;
  subtype?: string;
  server?: string;
  target?: string;
  nick?: string;
  message?: string;
  hostmask?: string;
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
  handleIncomingMessage(
    message: RoomMessage,
    options?: { sendResponse?: (text: string) => Promise<void> },
  ): Promise<void>;
  cancelProactive?(): void;
}

export interface IrcRoomMonitorOptions {
  roomConfig: RoomConfig;
  ignoreUsers?: string[];
  history: ChatHistoryStore;
  commandHandler: CommandLike;
  varlinkEvents?: IrcEventsClient;
  varlinkSender?: IrcSender;
  responseCleaner?: (text: string, nick: string) => string;
  logger?: Logger;
  logWriter?: RuntimeLogWriter;
  /** Override per-attempt retry delay (ms). Default: exponential backoff (2^attempt * 1000). */
  retryDelayMs?: number;
}

export class IrcRoomMonitor {
  private readonly varlinkEvents: IrcEventsClient;
  private readonly varlinkSender: IrcSender;
  private readonly responseCleaner: (text: string, nick: string) => string;
  private readonly logger: Logger;
  private readonly logWriter?: RuntimeLogWriter;
  private readonly serverNicks = new Map<string, string>();
  private readyResolve?: () => void;
  private readyReject?: (err: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });

  static fromRuntime(
    runtime: MuaddibRuntime,
    options?: { gateway?: RoomGateway; eventsWatcher?: ArcEventsWatcher },
  ): IrcRoomMonitor[] {
    const roomConfig = runtime.config.getRoomConfig("irc");
    const enabled = roomConfig.enabled ?? true;
    if (!enabled) {
      return [];
    }

    const socketPath = requireNonEmptyString(
      roomConfig.varlink?.socketPath,
      "IRC room is enabled but rooms.irc.varlink.socketPath is missing.",
    );

    const commandHandler = new RoomMessageHandler(runtime, "irc", {
      eventsWatcher: options?.eventsWatcher,
    });

    const varlinkSender = new VarlinkSender(socketPath);

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath,
        },
      },
      ignoreUsers: roomConfig.command?.ignoreUsers?.map(String),
      history: runtime.history,
      commandHandler,
      varlinkSender,
      logger: runtime.logger.getLogger("muaddib.rooms.irc.monitor"),
      logWriter: runtime.logger,
    });

    // Register IRC transport on the gateway so events can inject messages.
    if (options?.gateway) {
      const logWriter = runtime.logger;
      options.gateway.register("irc", {
        inject: async (serverTag, channelName, content) => {
          await monitor.ready;
          const mynick = await varlinkSender.getServerNick(serverTag);
          if (!mynick) {
            throw new Error(`Cannot inject into IRC: no nick for server ${serverTag}`);
          }
          const arc = buildArc(serverTag, channelName);
          const message: RoomMessage = {
            serverTag,
            channelName,
            arc,
            nick: "event",
            mynick,
            content,
            isDirect: true,
          };
          const run = async (): Promise<void> => {
            await commandHandler.executeEvent(message, async (text) => {
              const responseText = monitor.responseCleaner(text, message.nick);
              await varlinkSender.sendMessage(channelName, responseText, serverTag);
            });
          };
          await logWriter.withMessageContext({ arc, nick: "event", message: content }, run);
        },
        send: async (serverTag, channelName, text) => {
          await monitor.ready;
          const responseText = monitor.responseCleaner(text, "event");
          await varlinkSender.sendMessage(channelName, responseText, serverTag);
        },
      });
    }

    return [monitor];
  }

  constructor(private readonly options: IrcRoomMonitorOptions) {
    this.varlinkEvents =
      options.varlinkEvents ?? new VarlinkClient(options.roomConfig.varlink!.socketPath!);
    this.varlinkSender =
      options.varlinkSender ?? new VarlinkSender(options.roomConfig.varlink!.socketPath!);
    this.responseCleaner = options.responseCleaner ?? defaultResponseCleaner;
    this.logger = options.logger ?? CONSOLE_LOGGER;
    this.logWriter = options.logWriter;
  }

  async run(): Promise<void> {
    if (!(await this.connectWithRetry())) {
      this.readyReject?.(new Error("IRC monitor failed to connect"));
      this.logger.error("Could not establish varlink connection; exiting IRC monitor.");
      return;
    }

    this.readyResolve?.();
    this.logger.info("Muaddib started, waiting for IRC events...");

    const inFlightEvents = new InFlightTaskSet();

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
        inFlightEvents.add(
          this.processMessageEvent(event).catch((error) => {
            this.logger.error("IRC monitor failed to process event; continuing", error);
          }),
        );
      }

      if (response.error) {
        this.logger.error("IRC monitor received varlink error response", response.error);
        break;
      }
    }

    this.options.commandHandler.cancelProactive?.();

    await inFlightEvents.waitForAll();

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

    const ignoreUsers = this.options.ignoreUsers ?? [];
    if (
      ignoreUsers.some((u) => u.toLowerCase() === nick.toLowerCase()) ||
      ignoreUsers.some((u) => u.toLowerCase() === normalizedNick.toLowerCase())
    ) {
      this.logger.debug("Ignoring user", `nick=${nick}`, `normalized=${normalizedNick}`);
      return;
    }

    const inputMatch = inputMatchForMynick(mynick, normalizedMessage);
    const isPrivate = event.subtype !== "public";
    const isDirect = Boolean(inputMatch) || isPrivate;

    const effectiveNick = inputMatch?.groups?.nick ?? normalizedNick;
    const cleanedMessage = inputMatch?.groups?.content ?? normalizedMessage;

    const userAllowlist = this.options.roomConfig.userAllowlist;
    const trusted = userAllowlist
      ? matchIrcAllowlist(event.hostmask, userAllowlist)
      : undefined;

    const roomMessage: RoomMessage = {
      serverTag: server,
      channelName,
      arc: buildArc(server, channelName),
      nick: effectiveNick,
      mynick,
      content: isDirect ? cleanedMessage : normalizedMessage,
      isDirect,
      trusted,
      // Preserve the full channel message (e.g. "MuaddibLLM: keeppandoraopen.org") for history
      // and LLM context; only set when the bot-nick prefix was actually stripped.
      originalContent: inputMatch ? normalizedMessage : undefined,
    };

    const handleIncoming = async (): Promise<void> => {
      await this.options.commandHandler.handleIncomingMessage(roomMessage, {
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

    const arc = roomMessage.arc;
    const runDirectMessage = async (): Promise<void> => {
      this.logger.debug("Processing direct IRC message", `arc=${arc}`, `nick=${effectiveNick}`);
      await handleIncoming();
    };

    if (this.logWriter) {
      await this.logWriter.withMessageContext({ arc, nick: effectiveNick, message: normalizedMessage }, runDirectMessage);
    } else {
      await runDirectMessage();
    }
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

        const waitMs = this.options.retryDelayMs ?? 2 ** attempt * 1000;
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
  return text.replace(/\n+/g, " ; ").trim() || text;
}
