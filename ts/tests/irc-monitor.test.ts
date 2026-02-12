import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RuntimeLogWriter } from "../src/app/logging.js";
import { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { IrcRoomMonitor } from "../src/rooms/irc/monitor.js";

class FakeEventsClient {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async waitForEvents(): Promise<void> {}
  async receiveResponse(): Promise<Record<string, unknown> | null> {
    return null;
  }
}

class FakeSender {
  sent: Array<{ target: string; message: string; server: string }> = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getServerNick(): Promise<string | null> {
    return "muaddib";
  }

  async sendMessage(target: string, message: string, server: string): Promise<boolean> {
    this.sent.push({ target, message, server });
    return true;
  }
}

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

describe("IrcRoomMonitor", () => {
  it("routes direct message events into command handler and sender", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const sender = new FakeSender();
    const executeCalls: string[] = [];

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socket_path: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message, options) => {
          executeCalls.push(message.content);
          if (options.isDirect && options.sendResponse) {
            await options.sendResponse("line1\nline2");
          }
          await history.addMessage(message);
          await history.addMessage({
            ...message,
            nick: message.mynick,
            content: "line1\nline2",
          });
          return { response: "line1\nline2" };
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
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toEqual({
      target: "#test",
      message: "line1; line2",
      server: "libera",
    });

    const historyRows = await history.getFullHistory("libera", "#test");
    expect(historyRows).toHaveLength(2);

    await history.close();
  });

  it("ignores passive public messages when not addressed directly", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const sender = new FakeSender();
    let directFlag = false;

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socket_path: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message, options) => {
          directFlag = options.isDirect;
          await history.addMessage(message);
          return null;
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

    const historyRows = await history.getFullHistory("libera", "#test");
    expect(historyRows).toHaveLength(1);

    await history.close();
  });

  it("refreshes cached mynick after varlink reconnect so direct detection stays correct", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
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
    const seen: Array<{ mynick: string; content: string; isDirect: boolean }> = [];

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
          socket_path: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message, options) => {
          seen.push({
            mynick: message.mynick,
            content: message.content,
            isDirect: options.isDirect,
          });
          return null;
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
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let eventsDisconnectCalls = 0;
    let senderDisconnectCalls = 0;
    let senderConnectCalls = 0;

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socket_path: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async () => null,
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

    await expect((monitor as any).connectWithRetry(2)).resolves.toBe(true);

    expect(eventsDisconnectCalls).toBe(1);
    expect(senderDisconnectCalls).toBe(1);

    await history.close();
  });

  it("cleans up both varlink clients when waitForEvents fails on final startup attempt", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    let eventsDisconnectCalls = 0;
    let senderDisconnectCalls = 0;

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socket_path: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async () => null,
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
    const history = new ChatHistoryStore(":memory:", 20);
    await history.initialize();

    const logsHome = await mkdtemp(join(tmpdir(), "muaddib-irc-logs-"));
    let connectCalls = 0;

    const monitor = new IrcRoomMonitor({
      roomConfig: {
        varlink: {
          socket_path: "/tmp/varlink.sock",
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
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async () => null,
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

    await expect((monitor as any).connectWithRetry(2)).resolves.toBe(true);

    const datePath = new Date().toISOString().slice(0, 10);
    const systemLogPath = join(logsHome, "logs", datePath, "system.log");
    const systemLog = await readFile(systemLogPath, "utf-8");
    expect(systemLog).toContain("Connection attempt 1 failed");

    await rm(logsHome, { recursive: true, force: true });
    await history.close();
  });

  it("writes direct-message logs to arc-sharded files and keeps non-message logs in system.log", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
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
          socket_path: "/tmp/varlink.sock",
        },
      },
      history,
      logger: runtimeLogs.getLogger("muaddib.rooms.irc.monitor"),
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async () => {
          runtimeLogs.getLogger("muaddib.tests.command").debug("inside direct handler marker");
          return null;
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
    const arcDir = join(logsHome, "logs", datePath, "libera_main##ops_room");
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
    const history = new ChatHistoryStore(":memory:", 20);
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
          socket_path: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message) => {
          processed.push(message.content);
          if (processed.length === 1) {
            throw new Error("boom");
          }
          return null;
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

  it("processes IRC events concurrently without waiting for previous handler completion", async () => {
    const history = new ChatHistoryStore(":memory:", 20);
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
          socket_path: "/tmp/varlink.sock",
        },
      },
      history,
      commandHandler: {
        shouldIgnoreUser: () => false,
        handleIncomingMessage: async (message) => {
          if (message.content === "first") {
            firstStarted.resolve();
            await releaseFirst.promise;
            return null;
          }

          if (message.content === "second") {
            secondObserved.resolve();
            releaseFirst.resolve();
          }

          return null;
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
