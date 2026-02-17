import { homedir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  BaseVarlinkClient,
  NullTerminatedJsonParser,
  calculateIrcMaxPayload,
  jsonStringifyAscii,
  splitMessageForIrcPayload,
} from "../src/rooms/irc/varlink.js";
import { AsyncQueue } from "../src/utils/async-queue.js";

class InspectableVarlinkClient extends BaseVarlinkClient {
  get resolvedSocketPath(): string {
    return this.socketPath;
  }
}

describe("varlink helpers", () => {
  it("parses null-terminated JSON frames across chunk boundaries", () => {
    const parser = new NullTerminatedJsonParser();

    const part1 = '{"a":1}\0{"b"';
    const part2 = ':2}\0';

    const frames1 = parser.push(part1);
    const frames2 = parser.push(part2);

    expect(frames1).toEqual([{ a: 1 }]);
    expect(frames2).toEqual([{ b: 2 }]);
  });

  it("expands '~' in varlink socket path", () => {
    const client = new InspectableVarlinkClient("~/.irssi/varlink.sock");
    expect(client.resolvedSocketPath).toBe(`${homedir()}/.irssi/varlink.sock`);
  });

  it("splits long message into two payload-bounded parts", () => {
    const target = "#channel";
    const maxPayload = calculateIrcMaxPayload(target);
    const message = `${"a".repeat(maxPayload - 10)} ${"b".repeat(maxPayload)}`;

    const [first, second] = splitMessageForIrcPayload(message, maxPayload);

    expect(second).not.toBeNull();
    expect(Buffer.byteLength(first, "utf-8")).toBeLessThanOrEqual(maxPayload);
    expect(Buffer.byteLength(second ?? "", "utf-8")).toBeLessThanOrEqual(maxPayload);
  });

  it("AsyncQueue.drain() discards items and resolves pending waiters with sentinel", async () => {
    const queue = new AsyncQueue<number | null>();
    queue.push(1);
    queue.push(2);

    // Start a pending waiter (queue is empty after draining)
    const waiterPromise = (async () => {
      await queue.shift(); // 1
      await queue.shift(); // 2
      return await queue.shift(); // will block until drain
    })();

    // Let microtasks flush so the waiter reaches the blocking shift()
    await new Promise((r) => setTimeout(r, 0));

    queue.drain(null);
    const result = await waiterPromise;
    expect(result).toBeNull();

    // Queue is empty after drain — new push works normally
    queue.push(42);
    expect(await queue.shift()).toBe(42);
  });

  it("parser.reset() clears buffered partial data", () => {
    const parser = new NullTerminatedJsonParser();
    parser.push('{"partial":tr');
    parser.reset();
    const frames = parser.push('{"fresh":1}\0');
    expect(frames).toEqual([{ fresh: 1 }]);
  });

  it("jsonStringifyAscii escapes non-ASCII as \\uXXXX", () => {
    const result = jsonStringifyAscii({ message: "fascinující způsob" });
    expect(result).toBe('{"message":"fascinuj\\u00edc\\u00ed zp\\u016fsob"}');
    // Must be pure ASCII
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(result)).toBe(true);
  });

  it("never splits inside utf-8 codepoints", () => {
    const target = "#chan";
    const maxPayload = calculateIrcMaxPayload(target);
    const emoji = "🙂";
    const message = `${emoji.repeat(Math.floor(maxPayload / 4) - 2)} ${emoji.repeat(40)}`;

    const [first, second] = splitMessageForIrcPayload(message, maxPayload);

    expect(second).not.toBeNull();
    expect(Buffer.from(first, "utf-8").toString("utf-8")).toBe(first);
    expect(Buffer.from(second ?? "", "utf-8").toString("utf-8")).toBe(second);
  });
});
