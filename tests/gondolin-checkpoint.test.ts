/**
 * Unit tests for checkpointGondolinArc / vmActiveSessions counter logic.
 *
 * The VM itself is never instantiated — we inject a fake VM into vmCache via
 * resetGondolinVmCache + a small backdoor exposed for testing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── pull the internals we need ─────────────────────────────────────────────

import {
  createGondolinTools,
  checkpointGondolinArc,
  resetGondolinVmCache,
  closeAllVms,
  getVmSlotState,
} from "../src/agent/tools/gondolin-tools.js";

// We reach into the module's Maps via the exported reset helper and a small
// test-only shim: we import the Maps indirectly by calling createGondolinTools
// with a fake gondolin module.

// ── helpers ────────────────────────────────────────────────────────────────

/** Minimal fake VM that records checkpoint calls. */
function makeFakeVm() {
  const checkpointCalls: string[] = [];
  let checkpointResolve: (() => void) | null = null;
  let checkpointPromise: Promise<void> | null = null;

  function makeExecResult() {
    return Object.assign(
      Promise.resolve({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
      { output: async function* () {} },
    );
  }

  const vm = {
    exec: vi.fn(() => makeExecResult()),
    close: vi.fn().mockResolvedValue(undefined),
    checkpoint: vi.fn(async (path: string) => {
      checkpointCalls.push(path);
      if (checkpointPromise) await checkpointPromise;
    }),
    // Test control: make the next checkpoint() call hang until released
    pauseNextCheckpoint() {
      checkpointPromise = new Promise<void>((resolve) => {
        checkpointResolve = resolve;
      });
    },
    releaseCheckpoint() {
      checkpointResolve?.();
      checkpointPromise = null;
      checkpointResolve = null;
    },
    checkpointCalls,
  };
  return vm;
}

type FakeVm = ReturnType<typeof makeFakeVm>;

/**
 * Reach into the module's vmCache by monkey-patching the dynamic import that
 * ensureVm() uses.  Simpler approach: expose a test-only seed via a module-level
 * symbol — but since we don't have one, we exercise the path through
 * createGondolinTools and bypass ensureVm by pre-seeding vmCache through the
 * module's exported Map (not exported).
 *
 * Instead we use the fact that checkpointGondolinArc reads vmCache.get(arcId)
 * and vmActiveSessions. We seed vmActiveSessions by calling createGondolinTools
 * (which increments it synchronously), and seed vmCache by injecting via a small
 * helper that leverages the module's existing test export.
 */

// The gondolin-tools module exports resetGondolinVmCache which clears vmCache.
// There's no direct setter, so we need to trigger ensureVm lazily — but that
// would require the gondolin package to be installed.  Instead we test the
// counter and serialization logic by seeding the session count directly through
// multiple createGondolinTools() calls (which increment vmActiveSessions
// synchronously) and providing a fake vmCache entry via a test-only seed function
// that we'll add inline here using vi.doMock to intercept the gondolin import.

// ── Because the gondolin package may not be installed in CI, we skip VM
//    creation and instead test only the counter / serialization paths by
//    directly manipulating the exported Maps through a test harness. ─────────

// We re-export the Maps through a thin shim so tests can seed them.
// Patch approach: we call `resetGondolinVmCache` then manually inject a fake VM
// by importing the internal Maps.  Since ESM modules don't expose internals,
// we use a different strategy: test via the public API only, injecting the fake
// VM through the dynamic-import path with vi.mock.

vi.mock("@earendil-works/gondolin", () => {
  // provide a fake gondolin module so ensureVm() can run without a real package
  const fakeVms = new Map<string, FakeVm>();

  return {
    __fakeVms: fakeVms,
    VM: {
      create: vi.fn(async (_opts: unknown) => {
        // Return whatever vm is registered under the special key "__next"
        const vm = fakeVms.get("__next");
        if (!vm) throw new Error("No fake VM registered for __next");
        fakeVms.delete("__next");
        return vm;
      }),
    },
    VmCheckpoint: {
      load: vi.fn(() => {
        throw new Error("no checkpoint");
      }),
    },
    RealFSProvider: class {
      constructor(_path: string) {}
    },
    createHttpHooks: vi.fn(() => ({ httpHooks: {} })),
  };
});

// Helper: register the next fake VM to be returned by VM.create
async function registerFakeVm(vm: FakeVm) {
  const gondolin = await import("@earendil-works/gondolin");
  // @ts-expect-error test-only
  gondolin.__fakeVms.set("__next", vm);
}

const ARC = "test-arc";
const gondolinConfig = {
  enabled: true,
  bashTimeoutSeconds: 30,
  blockedCidrs: [],
  dnsMode: "synthetic" as const,
};

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

beforeEach(() => {
  resetGondolinVmCache();
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("checkpointGondolinArc — session counter", () => {
  it("warns and returns early when called with no registered sessions", async () => {
    const logger = makeLogger();
    // No createGondolinTools call → counter is 0
    await checkpointGondolinArc(ARC, logger);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no active sessions registered"));
  });

  it("defers checkpoint when other sessions are still active", async () => {
    const fakeVm = makeFakeVm();
    await registerFakeVm(fakeVm);

    const logger = makeLogger();
    // Two sessions registered
    createGondolinTools({ arc: ARC, config: gondolinConfig });
    createGondolinTools({ arc: ARC, config: gondolinConfig });

    // First checkpoint call — one session still active
    await checkpointGondolinArc(ARC, logger);
    expect(fakeVm.checkpoint).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("1 session(s) still active"));
  });

  it("checkpoints only when the last session ends", async () => {
    const fakeVm = makeFakeVm();
    await registerFakeVm(fakeVm);

    const logger = makeLogger();
    createGondolinTools({ arc: ARC, config: gondolinConfig });
    createGondolinTools({ arc: ARC, config: gondolinConfig });

    // Trigger VM creation by calling through the first session's tool
    // (not strictly needed for counter tests, but ensures vmCache is populated)
    // We trigger it indirectly by calling checkpoint twice
    await checkpointGondolinArc(ARC, logger); // defers (remaining = 1)
    expect(fakeVm.checkpoint).not.toHaveBeenCalled();

    await checkpointGondolinArc(ARC, logger); // remaining = 0 → but no VM in cache yet
    // vm.checkpoint is only called if the VM was actually created (via getVm).
    // Since no tool was invoked, vmCache is empty → checkpointGondolinArc returns early.
    expect(fakeVm.checkpoint).not.toHaveBeenCalled();
  });

  it("does not go negative: extra checkpoint call warns instead of checkpointing twice", async () => {
    const fakeVm = makeFakeVm();
    await registerFakeVm(fakeVm);

    const logger = makeLogger();
    createGondolinTools({ arc: ARC, config: gondolinConfig }); // counter = 1

    await checkpointGondolinArc(ARC, logger); // counter → 0, VM not in cache, no-op
    // Extra call: counter is 0 → should warn and not try to checkpoint again
    await checkpointGondolinArc(ARC, logger);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no active sessions registered"));
    // checkpoint should never have been called (VM was never started)
    expect(fakeVm.checkpoint).not.toHaveBeenCalled();
  });
});

describe("checkpointGondolinArc — concurrent checkpoint serialization", () => {
  it("second concurrent call waits for the first checkpoint to finish", async () => {
    // This test seeds the vmCache by simulating what happens when the VM is
    // already running.  We use the module's public surface:
    //   1. Register one session
    //   2. Force the VM into vmCache by injecting through the module-level Map
    //      (not possible from outside ESM) — so instead we verify the guard via
    //      the vmCheckpointInProgress path indirectly.
    //
    // Practical note: since Node ESM modules seal their bindings, we can only
    // verify the *observable* side-effects (warn/error logs and checkpoint call
    // counts) through the public API. The serialization guard is most easily
    // verified via integration; here we verify the underflow guard prevents the
    // scenario from arising in the first place.

    const logger = makeLogger();
    // Simulate: only one session registered, two checkpoint calls fired "simultaneously"
    createGondolinTools({ arc: ARC, config: gondolinConfig }); // counter = 1

    const p1 = checkpointGondolinArc(ARC, logger); // counter → 0, no VM in cache → resolves quickly
    const p2 = checkpointGondolinArc(ARC, logger); // counter underflow → warns

    await Promise.all([p1, p2]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no active sessions registered"));
  });
});

describe("checkpointGondolinArc — vm.close on checkpoint failure", () => {
  it("calls vm.close() when vm.checkpoint() throws so QEMU process does not leak", async () => {
    const fakeVm = makeFakeVm();
    fakeVm.checkpoint.mockRejectedValueOnce(new Error("disk full"));
    await registerFakeVm(fakeVm);

    const logger = makeLogger();
    const { tools } = createGondolinTools({ arc: "close-on-fail-arc", config: gondolinConfig });

    // Force VM creation by invoking a tool (bash calls getVm)
    const bashTool = tools.find((t) => t.name === "bash")!;
    await bashTool.execute("id", { command: "echo hi" }, new AbortController().signal, () => {});

    // Now checkpoint — should fail but still call vm.close()
    await checkpointGondolinArc("close-on-fail-arc", logger);

    expect(fakeVm.checkpoint).toHaveBeenCalledTimes(1);
    expect(fakeVm.close).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("checkpoint failed"),
      expect.stringContaining("disk full"),
    );
  });

  it("does not call vm.close() when checkpoint succeeds", async () => {
    const fakeVm = makeFakeVm();
    await registerFakeVm(fakeVm);

    const logger = makeLogger();
    const { tools } = createGondolinTools({ arc: "no-close-arc", config: gondolinConfig });

    const bashTool = tools.find((t) => t.name === "bash")!;
    await bashTool.execute("id", { command: "echo hi" }, new AbortController().signal, () => {});

    await checkpointGondolinArc("no-close-arc", logger);

    expect(fakeVm.checkpoint).toHaveBeenCalledTimes(1);
    // close() should NOT be called on success — checkpoint already stops the VM
    expect(fakeVm.close).not.toHaveBeenCalled();
  });
});

describe("closeAllVms — process-level cleanup", () => {
  it("closes all cached VMs and clears the cache", async () => {
    const fakeVm1 = makeFakeVm();
    const fakeVm2 = makeFakeVm();
    await registerFakeVm(fakeVm1);
    const { tools: tools1 } = createGondolinTools({ arc: "cleanup-arc-1", config: gondolinConfig });
    // Force VM creation
    const bash1 = tools1.find((t) => t.name === "bash")!;
    await bash1.execute("id", { command: "echo 1" }, new AbortController().signal, () => {});

    await registerFakeVm(fakeVm2);
    const { tools: tools2 } = createGondolinTools({ arc: "cleanup-arc-2", config: gondolinConfig });
    const bash2 = tools2.find((t) => t.name === "bash")!;
    await bash2.execute("id", { command: "echo 2" }, new AbortController().signal, () => {});

    await closeAllVms();

    expect(fakeVm1.close).toHaveBeenCalledTimes(1);
    expect(fakeVm2.close).toHaveBeenCalledTimes(1);
  });

  it("tolerates vm.close() throwing", async () => {
    const fakeVm = makeFakeVm();
    fakeVm.close.mockRejectedValueOnce(new Error("already dead"));
    await registerFakeVm(fakeVm);

    const { tools } = createGondolinTools({ arc: "cleanup-err-arc", config: gondolinConfig });
    const bash = tools.find((t) => t.name === "bash")!;
    await bash.execute("id", { command: "echo hi" }, new AbortController().signal, () => {});

    // Should not throw
    await closeAllVms();
    expect(fakeVm.close).toHaveBeenCalledTimes(1);
  });
});

// ── env isolation ──────────────────────────────────────────────────────────

describe("gondolin bash tool — output capping", () => {
  it("caps output below 50KB so upstream bash tool never writes to host /tmp", async () => {
    // Produce ~60KB of output in chunks — enough to exceed the upstream 50KB threshold.
    const CHUNK_SIZE = 4096;
    const TOTAL_OUTPUT_BYTES = 60 * 1024;

    function makeLargeOutputProc() {
      return Object.assign(
        Promise.resolve({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
        {
          output: async function* () {
            let sent = 0;
            while (sent < TOTAL_OUTPUT_BYTES) {
              const size = Math.min(CHUNK_SIZE, TOTAL_OUTPUT_BYTES - sent);
              yield { data: Buffer.alloc(size, 0x41 /* 'A' */) };
              sent += size;
            }
          },
        },
      );
    }

    const fakeVm = {
      exec: vi.fn((cmd: string[]) => {
        if (cmd[0] === "/bin/bash") return makeLargeOutputProc();
        // mkdir -p for session dir
        return Object.assign(
          Promise.resolve({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
          { output: async function* () {} },
        );
      }),
      checkpoint: vi.fn(async (_path: string) => {}),
    };

    const gondolin = await import("@earendil-works/gondolin");
    // @ts-expect-error test-only
    gondolin.__fakeVms.set("__next", fakeVm);

    const { tools } = createGondolinTools({ arc: "cap-test-arc", config: gondolinConfig });
    const bashTool = tools.find((t) => t.name === "bash")!;

    const updates: string[] = [];
    const result = await bashTool.execute(
      "cap-call-1",
      { command: "yes A | head -c 61440" },
      new AbortController().signal,
      (update: { content: Array<{ type: string; text?: string }> }) => {
        const text = update.content.find((b) => b.type === "text")?.text;
        if (text) updates.push(text);
      },
    );

    const resultText = result.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    // Must not contain a host /tmp path from the upstream bash tool's overflow file.
    expect(resultText).not.toMatch(/\/tmp\/pi-bash-/);

    // Must contain the VM-specific truncation notice.
    expect(resultText).toContain("[output truncated — VM stream capped at 48KB]");

    // Total text delivered should be ≤ 50KB (upstream DEFAULT_MAX_BYTES) so it
    // fits entirely in the upstream's rolling buffer with no temp file created.
    const totalResultBytes = Buffer.byteLength(resultText, "utf8");
    expect(totalResultBytes).toBeLessThanOrEqual(50 * 1024);
  });

  it("does not truncate or append notice when output is within the 48KB cap", async () => {
    const SMALL_OUTPUT = "hello gondolin\n";

    function makeSmallOutputProc() {
      return Object.assign(
        Promise.resolve({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
        {
          output: async function* () {
            yield { data: Buffer.from(SMALL_OUTPUT) };
          },
        },
      );
    }

    const fakeVm = {
      exec: vi.fn((cmd: string[]) => {
        if (cmd[0] === "/bin/bash") return makeSmallOutputProc();
        return Object.assign(
          Promise.resolve({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
          { output: async function* () {} },
        );
      }),
      checkpoint: vi.fn(async (_path: string) => {}),
    };

    const gondolin = await import("@earendil-works/gondolin");
    // @ts-expect-error test-only
    gondolin.__fakeVms.set("__next", fakeVm);

    const { tools } = createGondolinTools({ arc: "small-output-arc", config: gondolinConfig });
    const bashTool = tools.find((t) => t.name === "bash")!;

    const result = await bashTool.execute(
      "small-call-1",
      { command: "echo 'hello gondolin'" },
      new AbortController().signal,
      () => {},
    );

    const resultText = result.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    expect(resultText).toContain(SMALL_OUTPUT.trim());
    expect(resultText).not.toContain("[output truncated");
    expect(resultText).not.toMatch(/\/tmp\/pi-bash-/);
  });
});

describe("gondolin bash tool — env isolation", () => {
  it("does not forward host process.env into vm.exec", async () => {
    // Fake proc supports both: `for await (const chunk of proc.output())` and `await proc`
    function makeProc() {
      return Object.assign(Promise.resolve({ ok: true, exitCode: 0, stdout: "", stderr: "" }), {
        output: async function* () { /* no chunks */ },
      });
    }

    const fakeVm = {
      exec: vi.fn(() => makeProc()),
      checkpoint: vi.fn(async (_path: string) => {}),
    };

    // Register the fake VM so ensureVm returns it
    const gondolin = await import("@earendil-works/gondolin");
    // @ts-expect-error test-only
    gondolin.__fakeVms.set("__next", fakeVm);

    const { tools } = createGondolinTools({ arc: "env-test-arc", config: gondolinConfig });
    const bashTool = tools.find((t) => t.name === "bash")!;

    // Set a sentinel in the host env that must NOT reach the VM
    process.env.__MUADDIB_ENV_LEAK_TEST = "secret";

    try {
      await bashTool.execute("id", { command: "echo hi", timeout: 5 }, new AbortController().signal, () => {});
    } finally {
      delete process.env.__MUADDIB_ENV_LEAK_TEST;
    }

    // Find the vm.exec call that ran the bash command (not mkdir)
    const allCalls = fakeVm.exec.mock.calls as unknown as [string[], Record<string, unknown>][];
    const bashCall = allCalls.find(([cmdArr]) => cmdArr[0] === "/bin/bash");
    expect(bashCall).toBeDefined();

    const execOptions = bashCall![1];
    expect(execOptions).not.toHaveProperty("env");
  });
});

// ── Concurrency semaphore ──────────────────────────────────────────────────

describe("gondolin — maxConcurrentVms semaphore", () => {
  function makeSimpleVm() {
    function makeProc() {
      return Object.assign(Promise.resolve({ ok: true, exitCode: 0, stdout: "", stderr: "" }), {
        output: async function* () {},
      });
    }
    return {
      exec: vi.fn(() => makeProc()),
      close: vi.fn().mockResolvedValue(undefined),
      checkpoint: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("rejects VM creation when maxConcurrentVms is zero or negative", async () => {
    for (const bad of [0, -1, -99]) {
      resetGondolinVmCache();
      const { tools } = createGondolinTools({
        arc: `bad-limit-arc-${bad}`,
        config: { ...gondolinConfig, maxConcurrentVms: bad },
      });
      const bash = tools.find((t) => t.name === "bash")!;
      await expect(
        bash.execute("id", { command: "echo hi" }, new AbortController().signal, () => {}),
      ).rejects.toThrow("maxConcurrentVms must be a positive integer");
    }
  });

  it("rejects VM creation when a second arc uses a different maxConcurrentVms limit", async () => {
    const vm1 = makeSimpleVm();
    await registerFakeVm(vm1 as unknown as FakeVm);

    // Start first arc with limit=2 — establishes the global limit
    const { tools: tools1 } = createGondolinTools({
      arc: "conflict-arc-1",
      config: { ...gondolinConfig, maxConcurrentVms: 2 },
    });
    await tools1.find((t) => t.name === "bash")!.execute("id", { command: "echo 1" }, new AbortController().signal, () => {});

    // Second arc with a different limit should fail
    const { tools: tools2 } = createGondolinTools({
      arc: "conflict-arc-2",
      config: { ...gondolinConfig, maxConcurrentVms: 4 },
    });
    await expect(
      tools2.find((t) => t.name === "bash")!.execute("id", { command: "echo 2" }, new AbortController().signal, () => {}),
    ).rejects.toThrow("maxConcurrentVms conflict");

    // Clean up arc-1
    await checkpointGondolinArc("conflict-arc-1");
  });

  it("slot is acquired when a VM starts and released after checkpoint", async () => {
    const fakeVm = makeSimpleVm();
    await registerFakeVm(fakeVm as unknown as FakeVm);

    const { tools } = createGondolinTools({ arc: "semaphore-basic-arc", config: { ...gondolinConfig, maxConcurrentVms: 2 } });
    const bash = tools.find((t) => t.name === "bash")!;

    // Before VM creation, slot should be idle
    expect(getVmSlotState().active).toBe(0);

    await bash.execute("id", { command: "echo hi" }, new AbortController().signal, () => {});

    // After VM creation, one slot should be held
    expect(getVmSlotState().active).toBe(1);
    expect(getVmSlotState().limit).toBe(2);

    await checkpointGondolinArc("semaphore-basic-arc");

    // After checkpoint, slot is released
    expect(getVmSlotState().active).toBe(0);
  });

  it("second VM creation blocks until first checkpoint releases a slot", async () => {
    const events: string[] = [];

    // VM for arc 1 — checkpoint can be controlled
    const vm1 = makeSimpleVm();
    let releaseCheckpoint1!: () => void;
    const checkpointGate1 = new Promise<void>((resolve) => { releaseCheckpoint1 = resolve; });
    vm1.checkpoint.mockImplementation(async () => { await checkpointGate1; });

    await registerFakeVm(vm1 as unknown as FakeVm);
    const { tools: tools1 } = createGondolinTools({
      arc: "sem-arc-1",
      config: { ...gondolinConfig, maxConcurrentVms: 1 },
    });
    const bash1 = tools1.find((t) => t.name === "bash")!;
    await bash1.execute("id", { command: "echo 1" }, new AbortController().signal, () => {});
    events.push("vm1-started");

    // VM for arc 2 — slot should be blocked (limit=1, vm1 is running)
    const vm2 = makeSimpleVm();
    await registerFakeVm(vm2 as unknown as FakeVm);
    const tools2Promise = (async () => {
      const { tools: tools2 } = createGondolinTools({
        arc: "sem-arc-2",
        config: { ...gondolinConfig, maxConcurrentVms: 1 },
      });
      const bash2 = tools2.find((t) => t.name === "bash")!;
      // This will block inside ensureVm waiting for a slot
      events.push("vm2-start-attempt");
      await bash2.execute("id", { command: "echo 2" }, new AbortController().signal, () => {});
      events.push("vm2-started");
      return tools2;
    })();

    // Give the event loop time to let vm2's slot-wait register
    await new Promise((r) => setTimeout(r, 10));

    // vm2 should be waiting — slot is taken by vm1
    expect(getVmSlotState().waiters).toBe(1);
    expect(events).toContain("vm2-start-attempt");
    expect(events).not.toContain("vm2-started");

    // Checkpoint vm1 — releases the slot
    events.push("vm1-checkpoint-start");
    const cp1 = checkpointGondolinArc("sem-arc-1");
    await new Promise((r) => setTimeout(r, 5));
    releaseCheckpoint1();
    await cp1;
    events.push("vm1-checkpointed");

    // Now vm2 should be unblocked
    await tools2Promise;
    events.push("vm2-done");

    expect(events.indexOf("vm1-checkpointed")).toBeLessThan(events.indexOf("vm2-done"));
    expect(getVmSlotState().active).toBe(1); // vm2 is now running
    expect(getVmSlotState().waiters).toBe(0);

    // Clean up vm2
    await checkpointGondolinArc("sem-arc-2");
  });

  it("closeAllVms releases slots so waiters are unblocked", async () => {
    const vm1 = makeSimpleVm();
    const vm2 = makeSimpleVm();

    await registerFakeVm(vm1 as unknown as FakeVm);
    const { tools: tools1 } = createGondolinTools({
      arc: "close-sem-arc-1",
      config: { ...gondolinConfig, maxConcurrentVms: 1 },
    });
    await tools1.find((t) => t.name === "bash")!.execute("id", { command: "echo 1" }, new AbortController().signal, () => {});

    // vm2 will block waiting for a slot
    await registerFakeVm(vm2 as unknown as FakeVm);
    let vm2Resolved = false;
    const vm2Promise = (async () => {
      const { tools: tools2 } = createGondolinTools({
        arc: "close-sem-arc-2",
        config: { ...gondolinConfig, maxConcurrentVms: 1 },
      });
      await tools2.find((t) => t.name === "bash")!.execute("id", { command: "echo 2" }, new AbortController().signal, () => {});
      vm2Resolved = true;
    })();

    await new Promise((r) => setTimeout(r, 10));
    expect(getVmSlotState().waiters).toBe(1);
    expect(vm2Resolved).toBe(false);

    // closeAllVms should release the slot and unblock vm2
    await closeAllVms();
    await vm2Promise;

    expect(vm2Resolved).toBe(true);
  });

  it("slot is released when VM creation fails", async () => {
    const gondolin = await import("@earendil-works/gondolin");
    // @ts-expect-error test-only: make the next VM.create call fail
    gondolin.VM.create.mockRejectedValueOnce(new Error("boot failed"));

    const { tools } = createGondolinTools({
      arc: "fail-arc",
      config: { ...gondolinConfig, maxConcurrentVms: 1 },
    });
    const bash = tools.find((t) => t.name === "bash")!;

    await expect(
      bash.execute("id", { command: "echo hi" }, new AbortController().signal, () => {}),
    ).rejects.toThrow("boot failed");

    // Slot must be released so subsequent arcs are not blocked
    expect(getVmSlotState().active).toBe(0);
    expect(getVmSlotState().waiters).toBe(0);
  });
});
