export interface RoomMessage {
  serverTag: string;
  channelName: string;
  nick: string;
  mynick: string;
  content: string;
  /** Full original message before the bot-nick prefix was stripped (e.g. "MuaddibLLM: keeppandoraopen.org"). Set only when the bot was explicitly mentioned in a channel message and the mention was removed to produce `content`. Used for history storage and LLM context so the full intent is preserved. */
  originalContent?: string;
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
