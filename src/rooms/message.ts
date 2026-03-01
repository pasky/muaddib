export interface RoomMessage {
  serverTag: string;
  channelName: string;
  /** Filesystem-safe arc identifier, computed once at construction via `buildArc(serverTag, channelName)`. */
  readonly arc: string;
  nick: string;
  mynick: string;
  content: string;
  /** Full original message before the bot-nick prefix was stripped (e.g. "MuaddibLLM: keeppandoraopen.org"). Set only when the bot was explicitly mentioned in a channel message and the mention was removed to produce `content`. Used for history storage and LLM context so the full intent is preserved. */
  originalContent?: string;
  platformId?: string;
  threadId?: string;
  responseThreadId?: string;
  secrets?: Record<string, unknown>;
}

/**
 * Build a filesystem-safe arc identifier from a server tag and channel name.
 * Joins as `"${serverTag}#${channelName}"` then percent-encodes '%' and '/'.
 */
export function buildArc(serverTag: string, channelName: string): string {
  const raw = `${serverTag}#${channelName}`;
  return raw.replaceAll("%", "%25").replaceAll("/", "%2F");
}

/** Wrap the steered message payload in steering instructions. */
export function wrapSteeredMessage(message: string): string {
  return `<meta>Background channel message — DO NOT derail from your current task. Acknowledge only if directly relevant, otherwise ignore by continuing work or responding NULL.</meta>\n\n${message}\n\n<meta>Before reacting in any way, consider in <thinking> whether to adjust course in any way or continue in your current trajectory.</meta>`;
}
