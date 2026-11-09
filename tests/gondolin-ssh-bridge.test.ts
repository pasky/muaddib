/**
 * Gondolin's own SSH exec bridge, as patched by scripts/patch-deps.mjs.
 *
 * Unlike the other Gondolin tests these mock nothing: the real `bridgeSshExecChannel` runs
 * between two real ssh2 endpoints, so they hold for whatever makes the bridge correct, be it
 * our patch or a fixed upstream release. They fail against unpatched gondolin 0.14.0.
 */

import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const MIB = 1024 * 1024;

/** Reject on a stuck bridge, so the caller's `finally` still tears the sockets down before Vitest gives up. */
async function withDeadline<T>(operation: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 10_000);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Write a fixed 8 MiB (four ssh2 channel windows) without regard for backpressure, as an unhelpful peer would. */
function flood(stream: { write(chunk: Buffer): unknown }): void {
  const chunk = Buffer.alloc(32 * 1024, 0x61);
  for (let sent = 0; sent < 8 * MIB; sent += chunk.length) stream.write(chunk);
}

/**
 * Run Gondolin's real exec bridge between two real ssh2 endpoints:
 * guest client → proxy server → bridgeSshExecChannel → upstream server.
 */
async function startSshBridge(onUpstreamExec: (upstreamChannel: any) => void) {
  const gondolinPackageJson = createRequire(import.meta.url).resolve("@earendil-works/gondolin/package.json");
  const ssh2 = createRequire(gondolinPackageJson)("ssh2");
  const { bridgeSshExecChannel } = await import(
    pathToFileURL(join(dirname(gondolinPackageJson), "dist/src/qemu/ssh.js")).href
  );
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs1" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  }).privateKey;

  const closers: Array<() => void> = [];
  const close = () => closers.splice(0).reverse().forEach((closeOne) => closeOne());
  const listenForExec = async (onExec: (channel: any, command: string) => void): Promise<number> => {
    const server = new ssh2.Server({ hostKeys: [privateKey] }, (client: any) => {
      closers.push(() => client.end());
      client.on("error", () => {});
      client.on("authentication", (context: any) => context.accept());
      client.on("ready", () => client.on("session", (acceptSession: any) => {
        acceptSession().on("exec", (acceptExec: any, _reject: unknown, info: { command: string }) => {
          onExec(acceptExec(), info.command);
        });
      }));
    });
    closers.push(() => server.close());
    await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
    return server.address().port;
  };

  try {
    const upstreamPort = await listenForExec(onUpstreamExec);
    /** Upstream connections the bridge currently holds open. */
    const upstreamConnections = new Set<unknown>();
    const backend = {
      options: {},
      abortTcpSession: () => {},
      ssh: {
        agent: null,
        execPolicy: null,
        hostVerifier: () => true,
        upstreams: upstreamConnections,
        maxUpstreamConnectionsPerTcpSession: 4,
        maxUpstreamConnectionsTotal: 64,
        upstreamReadyTimeoutMs: 5_000,
        upstreamKeepaliveIntervalMs: 0,
        upstreamKeepaliveCountMax: 0,
      },
    };
    const session = {
      syntheticHostname: "127.0.0.1",
      dstPort: upstreamPort,
      srcIP: "192.0.2.2",
      srcPort: 40_000,
      ssh: { credential: { username: "muaddib", privateKey } },
    };

    let consumedFromGuest = 0;
    let resolveProxyChannel!: (channel: any) => void;
    const proxyChannelReady = new Promise<any>((resolveChannel) => { resolveProxyChannel = resolveChannel; });
    const proxyPort = await listenForExec((proxyChannel, command) => {
      // Count at emit rather than with a "data" listener, which would start the stream
      // flowing (and discard guest stdin) before the bridge has attached its own.
      const emit = proxyChannel.emit.bind(proxyChannel);
      proxyChannel.emit = (event: string, ...args: unknown[]) => {
        if (event === "data") consumedFromGuest += (args[0] as Buffer).length;
        return emit(event, ...args);
      };
      resolveProxyChannel(proxyChannel);
      void bridgeSshExecChannel({
        backend,
        key: "flow",
        session,
        proxy: { upstreams: new Set() },
        guestChannel: proxyChannel,
        command,
        guestUsername: "guest",
      });
    });

    const guest = new ssh2.Client();
    closers.push(() => guest.end());
    const guestChannel = await withDeadline(new Promise<any>((resolveChannel, rejectChannel) => {
      guest.once("error", rejectChannel).once("ready", () => {
        guest.exec("command", (error: Error | undefined, channel: any) => (error ? rejectChannel(error) : resolveChannel(channel)));
      });
      guest.connect({ host: "127.0.0.1", port: proxyPort, username: "guest", password: "unused" });
    }), "the guest exec channel");

    return {
      /** The guest's end of its exec channel. */
      guestChannel,
      /** The proxy's end of the same channel: what the bridge reads guest stdin from and writes output to. */
      proxyChannel: await withDeadline(proxyChannelReady, "the bridge to start"),
      /** Bytes of guest stdin the bridge has taken off the proxy channel so far. */
      consumedFromGuest: () => consumedFromGuest,
      upstreamConnections,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

/** Collect everything the guest receives until its channel closes. */
function guestOutcome(guestChannel: any): Promise<{ stdout: Buffer; stderr: string; exitCode: number | undefined }> {
  return withDeadline(new Promise((resolveOutcome) => {
    const chunks: Buffer[] = [];
    let stderr = "";
    guestChannel.on("data", (chunk: Buffer) => chunks.push(chunk));
    guestChannel.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    // ssh2 repeats the exit status on "close"; "exit" itself may fire before a late reader listens.
    guestChannel.on("close", (exitCode: number | undefined) => {
      resolveOutcome({ stdout: Buffer.concat(chunks), stderr, exitCode });
    });
  }), "the guest channel to close");
}

describe("gondolin — ssh exec bridge", () => {
  it("forwards guest stdin EOF to the proxied command", async () => {
    // Upstream behaves like `cat`: it answers only once its stdin is complete.
    const bridge = await startSshBridge((upstreamChannel) => {
      const chunks: Buffer[] = [];
      upstreamChannel.on("data", (chunk: Buffer) => chunks.push(chunk));
      upstreamChannel.on("end", () => {
        upstreamChannel.write(Buffer.concat(chunks));
        upstreamChannel.exit(0);
        upstreamChannel.end();
      });
    });
    try {
      const outcome = guestOutcome(bridge.guestChannel);
      bridge.guestChannel.end("wiki page body\n");
      expect((await outcome).stdout.toString()).toBe("wiki page body\n");
    } finally {
      bridge.close();
    }
  });

  it("delivers all output of a command that exits before the guest has read it", async () => {
    const bridge = await startSshBridge((upstreamChannel) => {
      upstreamChannel.stderr.write("warning: big page\n");
      flood(upstreamChannel);
      upstreamChannel.exit(3);
      upstreamChannel.end();
    });
    try {
      // Give the command time to finish and close upstream while its output is still in flight.
      await new Promise((resolveLater) => setTimeout(resolveLater, 300));
      const { stdout, stderr, exitCode } = await guestOutcome(bridge.guestChannel);
      expect({ stdoutMib: stdout.length / MIB, stderr, exitCode })
        .toEqual({ stdoutMib: 8, stderr: "warning: big page\n", exitCode: 3 });
    } finally {
      bridge.close();
    }
  });

  // Whoever stops reading must stall the sender, not grow the host process: the bridge runs
  // outside the VM's memory limit, and both ends are driven by the sandbox.
  it.each([
    {
      flow: "upstream stdout to a guest that stopped reading",
      upstream: (upstreamChannel: any) => flood(upstreamChannel),
      guest: () => {},
      reachedStalledSide: (bridge: any) => bridge.guestChannel.readableLength,
      queuedInBridge: (bridge: any) => bridge.proxyChannel.writableLength,
    },
    {
      flow: "upstream stderr to a guest that stopped reading",
      upstream: (upstreamChannel: any) => flood(upstreamChannel.stderr),
      guest: () => {},
      reachedStalledSide: (bridge: any) => bridge.guestChannel.stderr.readableLength,
      queuedInBridge: (bridge: any) => bridge.proxyChannel.stderr.writableLength,
    },
    {
      flow: "guest stdin to a command that never reads it",
      upstream: () => {},
      guest: (bridge: any) => flood(bridge.guestChannel),
      // The bridge only opens the upstream channel once its own upstream login completes.
      reachedStalledSide: (_bridge: any, upstreamChannel: any) => upstreamChannel?.readableLength ?? 0,
      queuedInBridge: (bridge: any, upstreamChannel: any) => bridge.consumedFromGuest() - upstreamChannel.readableLength,
    },
  ])("bounds what it queues when forwarding $flow", async ({ upstream, guest, reachedStalledSide, queuedInBridge }) => {
    let upstreamChannel: any;
    const bridge = await startSshBridge((channel) => {
      upstreamChannel = channel;
      upstream(channel);
    });
    try {
      guest(bridge);
      // Neither stalled side has a reader attached, so each accepts one channel window and stops.
      await withDeadline((async () => {
        let previous = -1;
        for (let stableFor = 0; stableFor < 5;) {
          await new Promise((resolveLater) => setTimeout(resolveLater, 50));
          const queued = reachedStalledSide(bridge, upstreamChannel) >= MIB ? queuedInBridge(bridge, upstreamChannel) : -1;
          stableFor = queued >= 0 && queued === previous ? stableFor + 1 : 0;
          previous = queued;
        }
      })(), "the flood to back up");

      // One window's worth (2 MiB) is the price of ssh2's stream buffers; the other ~4 MiB must stay with the sender.
      expect(queuedInBridge(bridge, upstreamChannel) / MIB).toBeLessThan(3);

      // A guest that walks away mid-transfer must still release the upstream connection.
      bridge.guestChannel.destroy();
      await withDeadline((async () => {
        while (bridge.upstreamConnections.size > 0) await new Promise((resolveLater) => setTimeout(resolveLater, 20));
      })(), "the upstream connection to be released");
    } finally {
      bridge.close();
    }
  });
});
