import { describe, expect, it } from "vitest";

import {
  NullTerminatedJsonParser,
  calculateIrcMaxPayload,
  splitMessageForIrcPayload,
} from "../src/rooms/irc/varlink.js";

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

  it("splits long message into two payload-bounded parts", () => {
    const target = "#channel";
    const maxPayload = calculateIrcMaxPayload(target);
    const message = `${"a".repeat(maxPayload - 10)} ${"b".repeat(maxPayload)}`;

    const [first, second] = splitMessageForIrcPayload(message, maxPayload);

    expect(second).not.toBeNull();
    expect(Buffer.byteLength(first, "utf-8")).toBeLessThanOrEqual(maxPayload);
    expect(Buffer.byteLength(second ?? "", "utf-8")).toBeLessThanOrEqual(maxPayload);
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
