import { createConnection, type Socket } from "node:net";

export class NullTerminatedJsonParser {
  private buffer = "";

  push(chunk: string): Array<Record<string, unknown>> {
    this.buffer += chunk;
    const frames: Array<Record<string, unknown>> = [];

    while (true) {
      const terminatorIndex = this.buffer.indexOf("\0");
      if (terminatorIndex < 0) {
        break;
      }

      const frame = this.buffer.slice(0, terminatorIndex);
      this.buffer = this.buffer.slice(terminatorIndex + 1);

      if (!frame) {
        continue;
      }

      frames.push(JSON.parse(frame) as Record<string, unknown>);
    }

    return frames;
  }
}

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }

    this.items.push(item);
  }

  async shift(): Promise<T> {
    if (this.items.length > 0) {
      return this.items.shift() as T;
    }

    return await new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}

export class BaseVarlinkClient {
  protected readonly socketPath: string;
  protected socket: Socket | null = null;
  protected readonly parser = new NullTerminatedJsonParser();
  protected readonly responses = new AsyncQueue<Record<string, unknown> | null>();

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });

      const onError = (error: Error): void => {
        socket.removeAllListeners();
        reject(error);
      };

      socket.once("error", onError);
      socket.once("connect", () => {
        socket.removeListener("error", onError);

        socket.on("data", (chunk: Buffer) => {
          const frames = this.parser.push(chunk.toString("utf-8"));
          for (const frame of frames) {
            this.responses.push(frame);
          }
        });

        socket.on("close", () => {
          this.responses.push(null);
        });

        socket.on("error", () => {
          this.responses.push(null);
        });

        this.socket = socket;
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.socket) {
      return;
    }

    const socket = this.socket;
    this.socket = null;

    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.end();
      socket.destroy();
    });
  }

  async sendCall(
    method: string,
    parameters: Record<string, unknown> = {},
    more = false,
  ): Promise<Record<string, unknown> | null> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Not connected to varlink socket");
    }

    const payload: Record<string, unknown> = {
      method,
      parameters,
    };
    if (more) {
      payload.more = true;
    }

    this.socket.write(`${JSON.stringify(payload)}\0`, "utf-8");

    if (more) {
      return null;
    }

    return await this.receiveResponse();
  }

  async receiveResponse(): Promise<Record<string, unknown> | null> {
    return await this.responses.shift();
  }

  async getServerNick(server: string): Promise<string | null> {
    const response = await this.sendCall("org.irssi.varlink.GetServerNick", {
      server,
    });

    const parameters = (response?.parameters as Record<string, unknown> | undefined) ?? {};
    const nick = parameters.nick;
    return typeof nick === "string" ? nick : null;
  }
}

export class VarlinkClient extends BaseVarlinkClient {
  async waitForEvents(): Promise<void> {
    await this.sendCall("org.irssi.varlink.WaitForEvent", {}, true);
  }
}

export function calculateIrcMaxPayload(target: string, safetyMargin = 60): number {
  const targetBytes = Buffer.byteLength(target, "utf-8");
  return Math.max(1, 512 - 12 - targetBytes - safetyMargin);
}

export function splitMessageForIrcPayload(message: string, maxPayload: number): [string, string | null] {
  if (Buffer.byteLength(message, "utf-8") <= maxPayload) {
    return [message, null];
  }

  const chars = Array.from(message);
  const cumulativeBytes: number[] = [];
  let running = 0;
  for (const char of chars) {
    running += Buffer.byteLength(char, "utf-8");
    cumulativeBytes.push(running);
  }

  let maxCharIndex = 0;
  for (let i = 0; i < cumulativeBytes.length; i += 1) {
    if (cumulativeBytes[i] <= maxPayload) {
      maxCharIndex = i + 1;
    } else {
      break;
    }
  }

  if (maxCharIndex === 0) {
    return ["", message];
  }

  const totalBytes = cumulativeBytes[cumulativeBytes.length - 1];
  const minFirstBytes = Math.max(0, totalBytes - maxPayload);
  const targetBytes = Math.max(minFirstBytes, Math.floor(maxPayload / 2));

  type Candidate = { idx: number; priority: number; bytesAt: number };
  const candidates: Candidate[] = [];

  const addCandidate = (idx: number, priority: number): void => {
    if (idx <= maxCharIndex) {
      candidates.push({
        idx,
        priority,
        bytesAt: cumulativeBytes[idx - 1],
      });
    }
  };

  for (let i = 0; i < maxCharIndex; i += 1) {
    const ch = chars[i];
    const next = chars[i + 1];
    const prev = chars[i - 1];

    if ((ch === "." || ch === "!" || ch === "?") && next === " ") {
      addCandidate(i + 2, 0);
    }

    if (ch === ";" && next === " ") {
      addCandidate(i + 2, 1);
    }

    if (ch === "," && next === " ") {
      addCandidate(i + 2, 2);
    }

    if (ch === "-" && prev === " " && next === " ") {
      addCandidate(i + 2, 3);
    }

    if (/\s/u.test(ch)) {
      addCandidate(i + 1, 4);
    }
  }

  if (candidates.length === 0) {
    const head = chars.slice(0, maxCharIndex).join("");
    const tail = chars.slice(maxCharIndex).join("");
    return [head, tail];
  }

  const valid = candidates.filter((candidate) => totalBytes - candidate.bytesAt <= maxPayload);

  if (valid.length === 0) {
    for (let i = 0; i < cumulativeBytes.length; i += 1) {
      if (totalBytes - cumulativeBytes[i] <= maxPayload) {
        const head = chars.slice(0, i + 1).join("");
        const tail = chars.slice(i + 1).join("");
        return [head, tail];
      }
    }

    const head = chars.slice(0, maxCharIndex).join("");
    const tail = chars.slice(maxCharIndex).join("");
    return [head, tail];
  }

  valid.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }

    return Math.abs(a.bytesAt - targetBytes) - Math.abs(b.bytesAt - targetBytes);
  });

  const splitAt = valid[0].idx;
  const head = chars.slice(0, splitAt).join("");
  const tail = chars.slice(splitAt).join("");
  return [head, tail];
}

function trimToPayloadWithEllipsis(message: string, maxPayload: number): string {
  if (Buffer.byteLength(message, "utf-8") <= maxPayload) {
    return message;
  }

  const ellipsis = "...";
  const effectivePayload = maxPayload - Buffer.byteLength(ellipsis, "utf-8");

  const chars = Array.from(message);
  let bytes = 0;
  let end = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const nextBytes = bytes + Buffer.byteLength(chars[i], "utf-8");
    if (nextBytes > effectivePayload) {
      break;
    }
    bytes = nextBytes;
    end = i + 1;
  }

  return `${chars.slice(0, end).join("")}${ellipsis}`;
}

class PromiseMutex {
  private queue = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release = (): void => {};
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class VarlinkSender extends BaseVarlinkClient {
  private readonly mutex = new PromiseMutex();

  async sendCall(method: string, parameters: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
    return await this.mutex.run(async () => await super.sendCall(method, parameters, false));
  }

  async sendMessage(target: string, message: string, server: string): Promise<boolean> {
    const maxPayload = calculateIrcMaxPayload(target);
    const [first, rest] = splitMessageForIrcPayload(message, maxPayload);

    if (rest === null) {
      const response = await this.sendCall("org.irssi.varlink.SendMessage", {
        target,
        message: first,
        server,
      });
      return Boolean((response?.parameters as Record<string, unknown> | undefined)?.success);
    }

    let second = rest.startsWith(" ") ? rest.slice(1) : rest;
    second = trimToPayloadWithEllipsis(second, maxPayload);

    let ok = true;
    for (const part of [first, second]) {
      const response = await this.sendCall("org.irssi.varlink.SendMessage", {
        target,
        message: part,
        server,
      });
      ok = ok && Boolean((response?.parameters as Record<string, unknown> | undefined)?.success);
    }

    return ok;
  }
}
