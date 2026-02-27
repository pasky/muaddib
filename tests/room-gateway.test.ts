import { describe, it, expect, vi } from "vitest";
import { RoomGateway, parseArc, type TransportHandler } from "../src/rooms/room-gateway.js";

describe("parseArc", () => {
  it("splits a simple arc into serverTag and channelName", () => {
    // Arc format: "serverTag#channelName" with % and / encoded.
    // The # separator itself is NOT encoded.
    const result = parseArc("irc.libera.chat##test");
    expect(result.serverTag).toBe("irc.libera.chat");
    expect(result.channelName).toBe("#test");
  });

  it("round-trips with buildArc", async () => {
    const { buildArc } = await import("../src/rooms/message.js");
    const serverTag = "irc.libera.chat";
    const channelName = "#test";
    const arc = buildArc(serverTag, channelName);
    const parsed = parseArc(arc);
    expect(parsed.serverTag).toBe(serverTag);
    expect(parsed.channelName).toBe(channelName);
  });

  it("round-trips discord arc", async () => {
    const { buildArc } = await import("../src/rooms/message.js");
    const serverTag = "discord:MyServer";
    const channelName = "general";
    const arc = buildArc(serverTag, channelName);
    const parsed = parseArc(arc);
    expect(parsed.serverTag).toBe(serverTag);
    expect(parsed.channelName).toBe(channelName);
  });

  it("round-trips slack arc", async () => {
    const { buildArc } = await import("../src/rooms/message.js");
    const serverTag = "slack:MyWorkspace";
    const channelName = "random";
    const arc = buildArc(serverTag, channelName);
    const parsed = parseArc(arc);
    expect(parsed.serverTag).toBe(serverTag);
    expect(parsed.channelName).toBe(channelName);
  });

  it("handles percent-encoded slashes", async () => {
    const { buildArc } = await import("../src/rooms/message.js");
    const serverTag = "irc.libera.chat";
    const channelName = "path/with/slashes";
    const arc = buildArc(serverTag, channelName);
    const parsed = parseArc(arc);
    expect(parsed.serverTag).toBe(serverTag);
    expect(parsed.channelName).toBe(channelName);
  });

  it("throws on invalid arc (no # separator)", () => {
    expect(() => parseArc("nohash")).toThrow("no '#' separator");
  });
});

describe("RoomGateway", () => {
  function createMockHandler(): TransportHandler {
    return {
      inject: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
  }

  it("routes IRC arcs to the irc transport", async () => {
    const { buildArc } = await import("../src/rooms/message.js");
    const gateway = new RoomGateway();
    const handler = createMockHandler();
    gateway.register("irc", handler);

    const arc = buildArc("irc.libera.chat", "#test");
    await gateway.inject(arc, "hello");

    expect(handler.inject).toHaveBeenCalledWith("irc.libera.chat", "#test", "hello");
  });

  it("routes Discord arcs to the discord transport", async () => {
    const { buildArc } = await import("../src/rooms/message.js");
    const gateway = new RoomGateway();
    const handler = createMockHandler();
    gateway.register("discord", handler);

    const arc = buildArc("discord:MyServer", "general");
    await gateway.send(arc, "hello");

    expect(handler.send).toHaveBeenCalledWith("discord:MyServer", "general", "hello");
  });

  it("routes Slack arcs to the slack transport", async () => {
    const { buildArc } = await import("../src/rooms/message.js");
    const gateway = new RoomGateway();
    const handler = createMockHandler();
    gateway.register("slack", handler);

    const arc = buildArc("slack:MyWorkspace", "random");
    await gateway.inject(arc, "hello");

    expect(handler.inject).toHaveBeenCalledWith("slack:MyWorkspace", "random", "hello");
  });

  it("throws when no transport is registered", async () => {
    const { buildArc } = await import("../src/rooms/message.js");
    const gateway = new RoomGateway();

    const arc = buildArc("irc.libera.chat", "#test");
    await expect(gateway.inject(arc, "hello")).rejects.toThrow("No transport registered");
  });
});
