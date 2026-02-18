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

/** Prefix for steered passive messages so the agent doesn't derail from its current task. */
export const STEER_PREFIX =
  "[Background channel message — DO NOT derail from your current task. " +
  "Acknowledge only if directly relevant, otherwise ignore.]\n";
