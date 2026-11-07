/**
 * IPC room: muaddib as the brain of a parent Node process, over the child_process IPC
 * channel (`spawn(..., { stdio: [..., "ipc"] })`). Built for pi-super's voice-only simple
 * mode, where a phone call is the room: the parent relays what the user said and speaks
 * whatever comes back.
 *
 * Unlike IRC there is no line protocol to fit into — responses are delivered whole, line
 * breaks included; `command.responseMaxBytes` is the only length limit. And the parent is
 * told when a request is finished, which a chat transport never needs to know.
 *
 * stdout stays the log; the channel is the room. Arcs are `ipc:<server>#<channel>`, both
 * chosen by the parent.
 */

import type { RoomConfig } from "../../config/muaddib-config.js";
import { CONSOLE_LOGGER, type Logger, type RuntimeLogWriter } from "../../app/logging.js";
import type { ArcEventsWatcher } from "../../events/watcher.js";
import { requireNonEmptyString } from "../../utils/index.js";
import type { MuaddibRuntime } from "../../runtime.js";
import { RoomMessageHandler } from "../command/message-handler.js";
import { InFlightTaskSet } from "../in-flight-task-set.js";
import { buildArc, type RoomMessage } from "../message.js";
import type { RoomGateway } from "../room-gateway.js";

/** Parent → muaddib. */
export interface IpcInboundMessage {
  type: "message";
  /** Echoed on every response and on `done`, so the parent can tell its requests apart. */
  id: string;
  server: string;
  channel: string;
  nick: string;
  content: string;
}

/** muaddib → parent. `id` is absent on responses nobody asked for (arc events). */
export type IpcOutbound =
  | { type: "ready"; mynick: string }
  | { type: "response"; id?: string; server: string; channel: string; text: string }
  | { type: "done"; id: string };

export interface IpcChannel {
  /** Rejects (or throws) when the parent is gone. */
  send(message: IpcOutbound): void | Promise<void>;
  onMessage(handler: (message: unknown) => void): void;
  /** The parent is gone: nobody is left to talk to. */
  onDisconnect(handler: () => void): void;
}

interface CommandLike {
  handleIncomingMessage: RoomMessageHandler["handleIncomingMessage"];
  cancelProactive?(): void;
}

export interface IpcRoomMonitorOptions {
  roomConfig: RoomConfig;
  commandHandler: CommandLike;
  channel: IpcChannel;
  logger?: Logger;
  logWriter?: RuntimeLogWriter;
  /** After the parent hangs up, how long requests in flight may take to finish (default 10s). */
  drainMs?: number;
  /** Called once the room has stopped. */
  onStopped?: () => void;
}

export const IPC_SERVER_TAG_PREFIX = "ipc:";

/**
 * How long the process may outlive its parent once the room has stopped, before it is
 * signalled to go. Nobody is listening any more, and whatever restarts the parent will
 * start a new muaddib on the same profile: two of them must not overlap for long.
 */
const ORPHAN_EXIT_MS = 15_000;

/** The channel this process was spawned with. */
export function processIpcChannel(): IpcChannel {
  const send = process.send?.bind(process);
  if (!send) {
    throw new Error("IPC room is enabled but muaddib was not started with an IPC channel (spawn with stdio 'ipc').");
  }
  return {
    // without a callback a closed channel is an asynchronous process 'error' — i.e. a crash
    send: (message) =>
      new Promise<void>((resolve, reject) => {
        if (!process.connected) {
          reject(new Error("IPC channel closed"));
          return;
        }
        send(message, (error: Error | null) => (error ? reject(error) : resolve()));
      }),
    onMessage: (handler) => {
      process.on("message", handler);
    },
    onDisconnect: (handler) => {
      process.once("disconnect", handler);
    },
  };
}

export function parseIpcInbound(raw: unknown): IpcInboundMessage {
  const message = raw as Partial<IpcInboundMessage> | null;
  if (message?.type !== "message") {
    throw new Error(`IPC: unknown message type ${JSON.stringify(message?.type)}`);
  }
  for (const key of ["id", "server", "channel", "nick", "content"] as const) {
    requireNonEmptyString(message[key], `IPC: message.${key} must be a non-empty string`);
  }
  return message as IpcInboundMessage;
}

export class IpcRoomMonitor {
  private readonly logger: Logger;
  private readonly mynick: string;

  static fromRuntime(
    runtime: MuaddibRuntime,
    options?: { gateway?: RoomGateway; eventsWatcher?: ArcEventsWatcher },
  ): IpcRoomMonitor[] {
    const roomConfig = runtime.config.getRoomConfig("ipc");
    if (!(roomConfig.enabled ?? false)) {
      return [];
    }

    const channel = processIpcChannel();
    const commandHandler = new RoomMessageHandler(runtime, "ipc", {
      eventsWatcher: options?.eventsWatcher,
    });
    const monitor = new IpcRoomMonitor({
      roomConfig,
      commandHandler,
      channel,
      logger: runtime.logger.getLogger("muaddib.rooms.ipc.monitor"),
      logWriter: runtime.logger,
      // The parent is gone: the room has stopped, but a stuck run or another room's monitor
      // could keep this process alive indefinitely. SIGTERM goes through the sandbox's own
      // bounded cleanup (gondolin closes its VMs) and then exits.
      onStopped: () => {
        setTimeout(() => process.kill(process.pid, "SIGTERM"), ORPHAN_EXIT_MS).unref();
      },
    });

    // Arc events (reminders, heartbeats) reach the parent like any other response.
    if (options?.gateway) {
      const logWriter = runtime.logger;
      options.gateway.register("ipc", {
        inject: async (serverTag, channelName, content) => {
          const arc = buildArc(serverTag, channelName);
          const message: RoomMessage = {
            serverTag,
            channelName,
            arc,
            nick: "event",
            mynick: monitor.mynick,
            content,
            isDirect: true,
            isPrivate: true,
          };
          await logWriter.withMessageContext({ arc, nick: "event", message: content }, async () => {
            await commandHandler.executeEvent(message, async (text) => {
              monitor.respond(serverTag, channelName, text);
            });
          });
        },
        send: async (serverTag, channelName, text) => {
          monitor.respond(serverTag, channelName, text);
        },
      });
    }

    return [monitor];
  }

  constructor(private readonly options: IpcRoomMonitorOptions) {
    this.logger = options.logger ?? CONSOLE_LOGGER;
    this.mynick = requireNonEmptyString(
      options.roomConfig.botName,
      "IPC room is enabled but rooms.ipc.botName is missing.",
    );
  }

  async run(): Promise<void> {
    const inFlight = new InFlightTaskSet();
    const disconnected = new Promise<void>((resolve) => this.options.channel.onDisconnect(resolve));

    this.options.channel.onMessage((raw) => {
      let message: IpcInboundMessage;
      try {
        message = parseIpcInbound(raw);
      } catch (error) {
        this.logger.error("IPC monitor dropped a malformed message", error);
        return;
      }
      inFlight.add(
        this.processMessage(message).catch((error) => {
          this.logger.error("IPC monitor failed to process message; continuing", error);
        }),
      );
    });

    this.post({ type: "ready", mynick: this.mynick });
    this.logger.info("Muaddib started, waiting for IPC messages...");

    await disconnected;
    this.logger.info("IPC parent disconnected; stopping.");
    this.options.commandHandler.cancelProactive?.();
    // nobody will hear the answers: give them a moment to land in history, not forever
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      inFlight.waitForAll(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.drainMs ?? 10_000);
      }),
    ]);
    clearTimeout(timer);
    this.options.onStopped?.();
  }

  async processMessage(inbound: IpcInboundMessage): Promise<void> {
    const serverTag = `${IPC_SERVER_TAG_PREFIX}${inbound.server}`;
    const arc = buildArc(serverTag, inbound.channel);
    const message: RoomMessage = {
      serverTag,
      channelName: inbound.channel,
      arc,
      nick: inbound.nick,
      mynick: this.mynick,
      content: inbound.content,
      // a private conversation with the parent's user: everything is addressed to us
      isDirect: true,
      isPrivate: true,
    };

    const handle = async (): Promise<void> => {
      try {
        await this.options.commandHandler.handleIncomingMessage(message, {
          sendResponse: async (text) => {
            this.respond(serverTag, inbound.channel, text, inbound.id);
          },
        });
      } finally {
        // also after a failure: the parent's "working on it" must not outlive the work
        this.post({ type: "done", id: inbound.id });
      }
    };

    if (this.options.logWriter) {
      await this.options.logWriter.withMessageContext({ arc, nick: inbound.nick, message: inbound.content }, handle);
    } else {
      await handle();
    }
  }

  respond(serverTag: string, channel: string, text: string, id?: string): void {
    this.post({
      type: "response",
      ...(id === undefined ? {} : { id }),
      server: serverTag.slice(IPC_SERVER_TAG_PREFIX.length),
      channel,
      text,
    });
  }

  private post(message: IpcOutbound): void {
    // the parent died mid-turn; run() is about to wind down on the disconnect
    const failed = (error: unknown): void => this.logger.warn("IPC send failed", error);
    try {
      void Promise.resolve(this.options.channel.send(message)).catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}
