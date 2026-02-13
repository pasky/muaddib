export interface RoomMessage {
  serverTag: string;
  channelName: string;
  nick: string;
  mynick: string;
  content: string;
  platformId?: string;
  threadId?: string;
  threadStarterId?: number;
  responseThreadId?: string;
  secrets?: Record<string, unknown>;
}

export function roomArc(message: Pick<RoomMessage, "serverTag" | "channelName">): string {
  return `${message.serverTag}#${message.channelName}`;
}
