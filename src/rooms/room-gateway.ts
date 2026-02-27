/**
 * RoomGateway — thin routing layer for injecting synthetic commands and
 * sending messages to any arc, regardless of which transport (IRC, Discord,
 * Slack) backs it.
 *
 * Anything that needs to push content into a room (arc events, future
 * heartbeat, etc.) goes through the gateway instead of coupling directly
 * to a specific transport.
 */

export interface TransportHandler {
  /** Inject a synthetic direct command into the command pipeline. */
  inject(serverTag: string, channelName: string, content: string): Promise<void>;
  /** Send a message to a channel (like sendResponse). */
  send(serverTag: string, channelName: string, text: string): Promise<void>;
}

/**
 * Split a percent-encoded arc back into its serverTag and channelName.
 * Arc format: `${serverTag}#${channelName}` with `%` and `/` encoded.
 */
export function parseArc(arc: string): { serverTag: string; channelName: string } {
  const decoded = arc.replaceAll("%2F", "/").replaceAll("%25", "%");
  const hashIdx = decoded.indexOf("#");
  if (hashIdx === -1) {
    throw new Error(`Invalid arc format (no '#' separator): ${arc}`);
  }
  return {
    serverTag: decoded.slice(0, hashIdx),
    channelName: decoded.slice(hashIdx + 1),
  };
}

function transportForServerTag(serverTag: string): string {
  if (serverTag.startsWith("discord:")) return "discord";
  if (serverTag.startsWith("slack:")) return "slack";
  return "irc";
}

export class RoomGateway {
  private readonly transports = new Map<string, TransportHandler>();

  register(transport: string, handler: TransportHandler): void {
    this.transports.set(transport, handler);
  }

  async inject(arc: string, content: string): Promise<void> {
    const { serverTag, channelName } = parseArc(arc);
    const transportName = transportForServerTag(serverTag);
    const handler = this.transports.get(transportName);
    if (!handler) {
      throw new Error(`No transport registered for "${transportName}" (arc: ${arc})`);
    }
    await handler.inject(serverTag, channelName, content);
  }

  async send(arc: string, text: string): Promise<void> {
    const { serverTag, channelName } = parseArc(arc);
    const transportName = transportForServerTag(serverTag);
    const handler = this.transports.get(transportName);
    if (!handler) {
      throw new Error(`No transport registered for "${transportName}" (arc: ${arc})`);
    }
    await handler.send(serverTag, channelName, text);
  }
}
