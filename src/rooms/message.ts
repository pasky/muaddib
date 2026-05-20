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
  /** Whether the message is a direct command (mention, DM) vs passive channel noise. Set at construction by the monitor. */
  isDirect?: boolean;
  /** Whether the user is trusted per the room's userAllowlist. Undefined when no allowlist is configured, true/false when it is. */
  trusted?: boolean;
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

/**
 * Check if a user identifier matches any entry in a platform allowlist (case-insensitive exact match).
 * Used by Discord and Slack monitors. Returns false if identifier is unavailable.
 */
export function matchPlatformAllowlist(identifier: string | undefined, allowlist: string[]): boolean {
  if (!identifier) return false;
  const lower = identifier.toLowerCase();
  return allowlist.some((entry) => entry.toLowerCase() === lower);
}

/**
 * Check if a hostmask matches any pattern in an IRC allowlist.
 * Patterns use glob-style `*` wildcards (e.g. `*!*@unaffiliated/pasky`).
 * Returns false if hostmask is unavailable.
 */
export function matchIrcAllowlist(hostmask: string | undefined, allowlist: string[]): boolean {
  if (!hostmask) return false;
  return allowlist.some((pattern) => {
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
      "i",
    );
    return regex.test(hostmask);
  });
}

/**
 * Custom AgentMessage type for passive room messages steered into a running
 * session. The body (channel timestamp + nick + content) is stored verbatim;
 * the surrounding `<meta>...</meta>` steering instructions are rendered at
 * LLM-call time by the wrapped `convertToLlm` in session-factory.ts, where the
 * actual predecessor in the transcript is known and the variant can be chosen
 * accordingly (after-assistant vs after-tool).
 */
export const MUADDIB_STEERED_PASSIVE_CUSTOM_TYPE = "muaddib.steered_passive";

export interface SteeredPassiveMessage {
  role: "custom";
  customType: typeof MUADDIB_STEERED_PASSIVE_CUSTOM_TYPE;
  /** Raw body text (e.g. `[HH:MM] <nick> message body`). */
  content: string;
  /** Not displayed in any TUI — muaddib has no TUI for this. */
  display: false;
  timestamp: number;
}

declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    steeredPassive: SteeredPassiveMessage;
  }
}

/** Build a SteeredPassiveMessage suitable for `agent.steer(...)`. */
export function buildSteeredPassiveMessage(body: string): SteeredPassiveMessage {
  return {
    role: "custom",
    customType: MUADDIB_STEERED_PASSIVE_CUSTOM_TYPE,
    content: body,
    display: false,
    timestamp: Date.now(),
  };
}

/**
 * Render the LLM-facing text for a steered passive message.
 *
 * `afterTool === true` means the message immediately follows a `toolResult` in
 * the transcript — i.e. the agent is mid-task, between a tool call and its
 * follow-up assistant turn. In that case the wording must encourage continuing
 * the in-progress work rather than treating the steer as a fresh prompt.
 *
 * `afterTool === false` is the post-assistant-text case (or no predecessor):
 * the agent has just finished responding, so the NULL-when-irrelevant hint
 * makes sense.
 */
export function renderSteeredPassive(body: string, opts: { afterTool: boolean }): string {
  const head = opts.afterTool
    ? "<meta>Background channel message — DO NOT derail from your in-progress task. Continue your current tool work; only adjust course if this message is directly relevant to what you are doing.</meta>"
    : "<meta>Background channel message — DO NOT derail from your current task and continue work / responding. Acknowledge only if directly relevant. If you just finished responding, respond with only the single word NULL unless this message should provoke a direct followup.</meta>";
  return `${head}\n\n${body}\n\n<meta>Before reacting in any way, consider silently whether to adjust course in any way or continue in your current trajectory.</meta>`;
}
