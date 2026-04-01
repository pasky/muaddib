import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { RuntimeLogWriter } from "../src/app/logging.js";
import type { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { RoomMessageHandler } from "../src/rooms/command/message-handler.js";
import { IrcRoomMonitor } from "../src/rooms/irc/monitor.js";
import { VarlinkSender } from "../src/rooms/irc/varlink.js";
import { buildArc } from "../src/rooms/message.js";
import { RoomGateway } from "../src/rooms/room-gateway.js";
import type { MuaddibRuntime } from "../src/runtime.js";
import { FakeEventsClient, FakeSender, baseCommandConfig } from "./e2e/helpers.js";
import { createTempHistoryStore } from "./test-helpers.js";
import { createTestRuntime } from "./test-runtime.js";

function createDeferred<T = void>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    resolve: resolve ?? (() => {}),
    reject: reject ?? (() => {}),
  };
}

function buildRuntime(configData: Record<string, unknown>, history: ChatHistoryStore): MuaddibRuntime {
  return createTestRuntime({ history, configData, authStorage: AuthStorage.inMemory() });
}

describe("IrcRoomMonitor", () => {
  it("fromRuntime returns [] when IRC is disabled", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const monitors = IrcRoomMonitor.fromRuntime(buildRuntime({
      rooms: {
        common: {
          command: baseCommandConfig(),
        },
        irc: {
          enabled: false,
        },
      },
    }, history));

    expect(monitors).toEqual([]);
    await history.close();
  });

  it("fromRuntime validates varlink.socketPath when IRC is enabled", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    expect(() => IrcRoomMonitor.fromRuntime(buildRuntime({
      rooms: {
        common: {
          command: baseCommandConfig(),
        },
        irc: {
          enabled: true,
        },
      },
    }, history))).toThrow("IRC room is enabled but rooms.irc.varlink.socketPath is missing.");

    await history.close();
  });

  it("fromRuntime enables IRC by default and builds monitor", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const monitors = IrcRoomMonitor.fromRuntime(buildRuntime({
      rooms: {
        common: {
          command: baseCommandConfig(),
        },
        irc: {
          varlink: {
            socketPath: "/tmp/muaddib-varlink.sock",
          },
        },
      },
    }, history));

    expect(monitors).toHaveLength(1);
    await history.close();
  });

  it("uses the same IRC cleaner for gateway send and inject responses", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const sendSpy = vi.spyOn(VarlinkSender.prototype, "sendMessage").mockResolvedValue(true);
    const nickSpy = vi.spyOn(VarlinkSender.prototype, "getServerNick").mockResolvedValue("muaddib");
    const executeEventSpy = vi.spyOn(RoomMessageHandler.prototype, "executeEvent").mockImplementation(
      async (_message, sendResponse) => {
        await sendResponse?.("lineA\n\nlineB");
      },
    );

    try {
      const gateway = new RoomGateway();
      const monitors = IrcRoomMonitor.fromRuntime(buildRuntime({
        rooms: {
          common: {
            command: baseCommandConfig(),
          },
          irc: {
            varlink: {
              socketPath: "/tmp/muaddib-varlink.sock",
            },
          },
        },
      }, history), {
        gateway,
      });

      expect(monitors).toHaveLength(1);

      // Gateway send/inject await monitor.ready; simulate a successful ready state.
      (monitors[0] as any).readyResolve?.();

      await gateway.send("libera##test", "first\n\nsecond");
      await gateway.inject("libera##test", "synthetic event");

      expect(sendSpy).toHaveBeenNthCalledWith(1, "#test", "first ; second", "libera");
      expect(sendSpy).toHaveBeenNthCalledWith(2, "#test", "lineA ; lineB", "libera");
      expect(nickSpy).toHaveBeenCalledWith("libera");
      expect(executeEventSpy).toHaveBeenCalledTimes(1);
    } finally {
      executeEventSpy.mockRestore();
      nickSpy.mockRestore();
      sendSpy.mockRestore();
      await history.close();
    }
  });

  it("routes direct message events into command handler and sender", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const sender = new FakeSender();
    const executeCalls: string[] = [];
    const originalContentCalls: Array<string | undefined> = [];

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async (message, options) => {
          executeCalls.push(message.content);
          originalContentCalls.push(message.originalContent);
          if (message.isDirect && options?.sendResponse) {
            await options?.sendResponse("line1\n\nline2");
          }
          await history.addMessage(message);
          await history.addMessage({
            ...message,
            nick: message.mynick,
            content: "line1\nline2",
          });

        },
      },
      varlinkEvents: new FakeEventsClient(),
      varlinkSender: sender,
    });

    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "alice",
      message: "muaddib: hello there",
    });

    expect(executeCalls).toEqual(["hello there"]);
    // originalContent preserves the bot-nick prefix that was stripped for command dispatch
    expect(originalContentCalls).toEqual(["muaddib: hello there"]);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toEqual({
      target: "#test",
      message: "line1 ; line2",
      server: "libera",
    });

    const historyRows = await history.getFullHistory(buildArc("libera", "#test"));
    expect(historyRows).toHaveLength(2);
    // Inbound user message stored with full original content (bot-nick preserved)
    expect(historyRows[0].message).toBe("<alice> muaddib: hello there");
    // Bot response stored as-is (no originalContent bleed-through)
    expect(historyRows[1].message).toBe("<muaddib> line1\nline2");

    await history.close();
  });

  it("does not let scrollback-pasted messages inject arbitrary nick via angle brackets", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const sender = new FakeSender();
    const seenNicks: string[] = [];

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenNicks.push(message.nick);
        },
      },
      varlinkEvents: new FakeEventsClient(),
      varlinkSender: sender,
    });

    // Simulate otis pasting scrollback: "Muaddib: !s 19:42 <@otis> Muaddib: !s do something"
    // The old regex would capture "Muaddib: !s 19:42 <@otis> " as the nick group.
    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "IRCnet",
      target: "#test",
      nick: "otis",
      message: "muaddib: !s 19:42 <@otis> muaddib: !s do something",
    });

    // effectiveNick must be the real IRC sender, not the injected text
    expect(seenNicks).toEqual(["otis"]);

    await history.close();
  });

  it("extracts bridge nick from angle-bracket prefix with valid IRC nick chars", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const sender = new FakeSender();
    const seenNicks: string[] = [];
    const seenContents: string[] = [];

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenNicks.push(message.nick);
          seenContents.push(message.content);
        },
      },
      varlinkEvents: new FakeEventsClient(),
      varlinkSender: sender,
    });

    // Bridge-style message with valid IRC nick in angle brackets
    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "alice",
      message: "<@otis> muaddib: hello",
    });

    expect(seenNicks).toEqual(["<@otis> "]);
    expect(seenContents).toEqual(["hello"]);

    await history.close();
  });

  it("normalizes bridge nick without leading angle bracket (nick> format)", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const sender = new FakeSender();
    const seenNicks: string[] = [];
    const seenContents: string[] = [];

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenNicks.push(message.nick);
          seenContents.push(message.content);
        },
      },
      varlinkEvents: new FakeEventsClient(),
      varlinkSender: sender,
    });

    // Bridge using nick> format (no leading <), e.g. hprmbridge
    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "hprmbridge",
      message: "badschemata> muaddib: What about RAM prices?",
    });

    expect(seenNicks).toEqual(["badschemata"]);
    expect(seenContents).toEqual(["What about RAM prices?"]);

    await history.close();
  });

  it("ignores passive public messages when not addressed directly", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const sender = new FakeSender();
    let directFlag = false;

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          directFlag = message.isDirect ?? false;
          await history.addMessage(message);
        },
      },
      varlinkEvents: new FakeEventsClient(),
      varlinkSender: sender,
    });

    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "alice",
      message: "just chatting",
    });

    expect(directFlag).toBe(false);
    expect(sender.sent).toHaveLength(0);

    const historyRows = await history.getFullHistory(buildArc("libera", "#test"));
    expect(historyRows).toHaveLength(1);

    await history.close();
  });

  it("refreshes cached mynick after varlink reconnect so direct detection stays correct", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const responses: Array<Record<string, unknown> | null> = [
      {
        parameters: {
          event: {
            type: "message",
            subtype: "public",
            server: "libera",
            target: "#test",
            nick: "alice",
            message: "muaddib: first",
          },
        },
      },
      null,
      {
        parameters: {
          event: {
            type: "message",
            subtype: "public",
            server: "libera",
            target: "#test",
            nick: "alice",
            message: "muaddib2: second",
          },
        },
      },
      {
        error: "done",
      },
    ];

    let offset = 0;
    const seen: Array<{ mynick: string; content: string; isDirect: boolean | undefined }> = [];

    const sender = {
      connectionGeneration: -1,
      async connect(): Promise<void> {
        this.connectionGeneration += 1;
      },
      async disconnect(): Promise<void> {},
      async sendMessage(): Promise<boolean> {
        return true;
      },
      async getServerNick(): Promise<string | null> {
        return this.connectionGeneration === 0 ? "muaddib" : "muaddib2";
      },
    };

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seen.push({
            mynick: message.mynick,
            content: message.content,
            isDirect: message.isDirect,
          });
        },
      },
      varlinkEvents: {
        connect: async () => {},
        disconnect: async () => {},
        waitForEvents: async () => {},
        receiveResponse: async () => {
          const response = responses[offset];
          offset += 1;
          return response ?? null;
        },
      },
      varlinkSender: sender,
    });

    await expect(monitor.run()).resolves.toBeUndefined();

    expect(seen).toEqual([
      {
        mynick: "muaddib",
        content: "first",
        isDirect: true,
      },
      {
        mynick: "muaddib2",
        content: "second",
        isDirect: true,
      },
    ]);

    await history.close();
  });

  it("cleans up partially-connected varlink clients before retrying startup connect", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    let eventsDisconnectCalls = 0;
    let senderDisconnectCalls = 0;
    let senderConnectCalls = 0;

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async () => {},
      },
      varlinkEvents: {
        connect: async () => {},
        disconnect: async () => {
          eventsDisconnectCalls += 1;
        },
        waitForEvents: async () => {},
        receiveResponse: async () => ({ error: "done" }),
      },
      varlinkSender: {
        connect: async () => {
          senderConnectCalls += 1;
          if (senderConnectCalls === 1) {
            throw new Error("sender connect failed");
          }
        },
        disconnect: async () => {
          senderDisconnectCalls += 1;
        },
        sendMessage: async () => true,
        getServerNick: async () => "muaddib",
      },
    });

    vi.useFakeTimers();
    const promise = (monitor as any).connectWithRetry(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBe(true);
    vi.useRealTimers();

    expect(eventsDisconnectCalls).toBe(1);
    expect(senderDisconnectCalls).toBe(1);

    await history.close();
  });

  it("cleans up both varlink clients when waitForEvents fails on final startup attempt", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    let eventsDisconnectCalls = 0;
    let senderDisconnectCalls = 0;

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async () => {},
      },
      varlinkEvents: {
        connect: async () => {},
        disconnect: async () => {
          eventsDisconnectCalls += 1;
        },
        waitForEvents: async () => {
          throw new Error("wait failed");
        },
        receiveResponse: async () => ({ error: "done" }),
      },
      varlinkSender: {
        connect: async () => {},
        disconnect: async () => {
          senderDisconnectCalls += 1;
        },
        sendMessage: async () => true,
        getServerNick: async () => "muaddib",
      },
    });

    await expect((monitor as any).connectWithRetry(1)).resolves.toBe(false);

    expect(eventsDisconnectCalls).toBe(1);
    expect(senderDisconnectCalls).toBe(1);

    await history.close();
  });

  it("logs failed startup connection attempts before retrying", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const logsHome = await mkdtemp(join(tmpdir(), "muaddib-irc-logs-"));
    let connectCalls = 0;

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      logger: new RuntimeLogWriter({
        muaddibHome: logsHome,
        stdout: {
          write: () => true,
        } as unknown as NodeJS.WriteStream,
      }).getLogger("muaddib.rooms.irc.monitor"),
      commandHandler: {
        handleIncomingMessage: async () => {},
      },
      varlinkEvents: {
        connect: async () => {
          connectCalls += 1;
          if (connectCalls === 1) {
            throw new Error("connect failed once");
          }
        },
        disconnect: async () => {},
        waitForEvents: async () => {},
        receiveResponse: async () => ({ error: "done" }),
      },
      varlinkSender: {
        connect: async () => {},
        disconnect: async () => {},
        sendMessage: async () => true,
        getServerNick: async () => "muaddib",
      },
    });

    vi.useFakeTimers();
    const promise = (monitor as any).connectWithRetry(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBe(true);
    vi.useRealTimers();

    const datePath = new Date().toISOString().slice(0, 10);
    const systemLogPath = join(logsHome, "logs", datePath, "system.log");
    const systemLog = await readFile(systemLogPath, "utf-8");
    expect(systemLog).toContain("Connection attempt 1 failed");

    await rm(logsHome, { recursive: true, force: true });
    await history.close();
  });

  it("writes direct-message logs to arc-sharded files and keeps non-message logs in system.log", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const logsHome = await mkdtemp(join(tmpdir(), "muaddib-irc-message-logs-"));
    const fixedNow = new Date(2026, 1, 12, 13, 14, 15, 123);
    const runtimeLogs = new RuntimeLogWriter({
      muaddibHome: logsHome,
      nowProvider: () => fixedNow,
      stdout: {
        write: () => true,
      } as unknown as NodeJS.WriteStream,
    });

    runtimeLogs.getLogger("muaddib.tests.system").info("outside context marker");

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      logger: runtimeLogs.getLogger("muaddib.rooms.irc.monitor"),
      logWriter: runtimeLogs,
      commandHandler: {
        handleIncomingMessage: async () => {
          runtimeLogs.getLogger("muaddib.tests.command").debug("inside direct handler marker");
        },
      },
      varlinkEvents: new FakeEventsClient(),
      varlinkSender: new FakeSender(),
    });

    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera/main",
      target: "#ops\\room",
      nick: "alice",
      message: "muaddib: Hello THERE!!! / test",
    });

    const datePath = fixedNow.toISOString().slice(0, 10);
    const arcDir = join(logsHome, "logs", datePath, "libera%2Fmain##ops_room");
    const arcFiles = await readdir(arcDir);

    expect(arcFiles).toHaveLength(1);
    expect(arcFiles[0]).toBe("13-14-15-alice-muaddib_hello_there_test.log");

    const messageLog = await readFile(join(arcDir, arcFiles[0]), "utf-8");
    expect(messageLog).toContain("inside direct handler marker");
    expect(messageLog).toContain("Processing direct IRC message");

    const systemLogPath = join(logsHome, "logs", datePath, "system.log");
    const systemLog = await readFile(systemLogPath, "utf-8");
    expect(systemLog).toContain("outside context marker");
    expect(systemLog).toContain("Starting message log:");
    expect(systemLog).toContain("Finished message log:");
    expect(systemLog).not.toContain("inside direct handler marker");

    await rm(logsHome, { recursive: true, force: true });
    await history.close();
  });

  it("keeps event loop alive after a single handler failure", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const responses: Array<Record<string, unknown>> = [
      {
        parameters: {
          event: {
            type: "message",
            subtype: "public",
            server: "libera",
            target: "#test",
            nick: "alice",
            message: "first",
          },
        },
      },
      {
        parameters: {
          event: {
            type: "message",
            subtype: "public",
            server: "libera",
            target: "#test",
            nick: "alice",
            message: "second",
          },
        },
      },
      {
        error: "done",
      },
    ];

    let offset = 0;
    const processed: string[] = [];

    const sender = new FakeSender();
    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          processed.push(message.content);
          if (processed.length === 1) {
            throw new Error("boom");
          }
        },
      },
      varlinkEvents: {
        connect: async () => {},
        disconnect: async () => {},
        waitForEvents: async () => {},
        receiveResponse: async () => {
          const response = responses[offset];
          offset += 1;
          return response ?? null;
        },
      },
      varlinkSender: sender,
    });

    await expect(monitor.run()).resolves.toBeUndefined();
    expect(processed).toEqual(["first", "second"]);

    await history.close();
  });

  it("ready promise resolves after successful connectWithRetry", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async () => {},
      },
      varlinkEvents: {
        connect: async () => {},
        disconnect: async () => {},
        waitForEvents: async () => {},
        receiveResponse: async () => ({ error: "done" }),
      },
      varlinkSender: new FakeSender(),
    });

    const runPromise = monitor.run();
    // ready should resolve once connectWithRetry succeeds
    await expect(monitor.ready).resolves.toBeUndefined();
    await runPromise;

    await history.close();
  });

  it("ready promise rejects when connectWithRetry fails", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async () => {},
      },
      retryDelayMs: 0,
      varlinkEvents: {
        connect: async () => {
          throw new Error("connection refused");
        },
        disconnect: async () => {},
        waitForEvents: async () => {},
        receiveResponse: async () => null,
      },
      varlinkSender: {
        connect: async () => {
          throw new Error("connection refused");
        },
        disconnect: async () => {},
        sendMessage: async () => true,
        getServerNick: async () => "muaddib",
      },
    });

    const runPromise = monitor.run();
    await expect(monitor.ready).rejects.toThrow("IRC monitor failed to connect");
    await runPromise;

    await history.close();
  });

  it("sets trusted=true when hostmask matches allowlist pattern", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    let seenTrusted: boolean | undefined;

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        userAllowlist: ["*!*@unaffiliated/pasky", "*!*@freenode/staff/*"],
        varlink: { socketPath: "/tmp/varlink.sock" },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenTrusted = message.trusted;
        },
      },
      varlinkEvents: new FakeEventsClient(),
      varlinkSender: new FakeSender(),
    });

    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "pasky",
      message: "hello",
      hostmask: "pasky!~pasky@unaffiliated/pasky",
    });

    expect(seenTrusted).toBe(true);
    await history.close();
  });

  it("sets trusted=false when hostmask does not match allowlist", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    let seenTrusted: boolean | undefined;

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        userAllowlist: ["*!*@unaffiliated/pasky"],
        varlink: { socketPath: "/tmp/varlink.sock" },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenTrusted = message.trusted;
        },
      },
      varlinkEvents: new FakeEventsClient(),
      varlinkSender: new FakeSender(),
    });

    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "stranger",
      message: "hello",
      hostmask: "stranger!~user@some.host.com",
    });

    expect(seenTrusted).toBe(false);
    await history.close();
  });

  it("sets trusted=false when allowlist is configured but hostmask is missing", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    let seenTrusted: boolean | undefined;

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        userAllowlist: ["*!*@unaffiliated/pasky"],
        varlink: { socketPath: "/tmp/varlink.sock" },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenTrusted = message.trusted;
        },
      },
      varlinkEvents: new FakeEventsClient(),
      varlinkSender: new FakeSender(),
    });

    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "alice",
      message: "hello",
    });

    expect(seenTrusted).toBe(false);
    await history.close();
  });

  it("leaves trusted undefined when no allowlist is configured", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    let seenTrusted: boolean | undefined = true; // sentinel to detect undefined

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: { socketPath: "/tmp/varlink.sock" },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          seenTrusted = message.trusted;
        },
      },
      varlinkEvents: new FakeEventsClient(),
      varlinkSender: new FakeSender(),
    });

    await monitor.processMessageEvent({
      type: "message",
      subtype: "public",
      server: "libera",
      target: "#test",
      nick: "alice",
      message: "hello",
    });

    expect(seenTrusted).toBeUndefined();
    await history.close();
  });

  it("processes IRC events concurrently without waiting for previous handler completion", async () => {
    const history = createTempHistoryStore(20);
    await history.initialize();

    const responses: Array<Record<string, unknown>> = [
      {
        parameters: {
          event: {
            type: "message",
            subtype: "public",
            server: "libera",
            target: "#test",
            nick: "alice",
            message: "muaddib: first",
          },
        },
      },
      {
        parameters: {
          event: {
            type: "message",
            subtype: "public",
            server: "libera",
            target: "#test",
            nick: "alice",
            message: "muaddib: second",
          },
        },
      },
      {
        error: "done",
      },
    ];

    let offset = 0;
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const secondObserved = createDeferred<void>();

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socketPath: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        handleIncomingMessage: async (message) => {
          if (message.content === "first") {
            firstStarted.resolve();
            await releaseFirst.promise;
          }

          if (message.content === "second") {
            secondObserved.resolve();
            releaseFirst.resolve();
          }

        },
      },
      varlinkEvents: {
        connect: async () => {},
        disconnect: async () => {},
        waitForEvents: async () => {},
        receiveResponse: async () => {
          const response = responses[offset];
          offset += 1;
          return response ?? null;
        },
      },
      varlinkSender: new FakeSender(),
    });

    const runPromise = monitor.run();

    await firstStarted.promise;
    await secondObserved.promise;
    await expect(runPromise).resolves.toBeUndefined();

    await history.close();
  });
});
