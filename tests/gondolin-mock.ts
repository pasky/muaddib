/**
 * Test double for `@earendil-works/gondolin`, plus the helpers that drive it.
 *
 * Gondolin tests never boot a VM. `ensureVm()` reaches the package through a dynamic
 * import, so mocking that module lets a test hand it a fake VM and inspect the options the
 * VM would have been created with. vi.mock is per test file, so each file installs it:
 *
 *   vi.mock("@earendil-works/gondolin", async (importOriginal) =>
 *     (await import("./gondolin-mock.js")).buildGondolinMock(importOriginal));
 *
 * This module deliberately imports nothing from `src/` so it can be pulled in from inside
 * that factory without an import cycle through the modules that import gondolin.
 */

import { writeFileSync } from "node:fs";

import { type Mock, vi } from "vitest";

export interface FakeVm {
  exec: Mock;
  writeFile: Mock;
  close: Mock;
  checkpoint: Mock;
  /** Make the next checkpoint() call hang until releaseCheckpoint(). */
  pauseNextCheckpoint(): void;
  releaseCheckpoint(): void;
  checkpointCalls: string[];
}

/** Minimal fake VM that records checkpoint calls. */
export function makeFakeVm(): FakeVm {
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
    writeFile: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    checkpoint: vi.fn(async (path: string) => {
      checkpointCalls.push(path);
      writeFileSync(path, "fake-checkpoint");
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

/** A syntactically valid ed25519 public key: wire blob plus its "<type> <base64>" text form. */
export function fakeSshPublicKey(fill: number) {
  const sshString = (value: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
  };
  const blob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(Buffer.alloc(32, fill))]);
  return { blob, line: `ssh-ed25519 ${blob.toString("base64")}` };
}

/** Tracks MemoryProvider instances created during VM setup (for skill VFS assertions). */
export const memoryProviderInstances: Array<{
  files: Map<string, string>;
  readOnly: boolean;
}> = [];

/** Factory body for `vi.mock("@earendil-works/gondolin", ...)`; see the module comment. */
export async function buildGondolinMock(importOriginal: <T>() => Promise<T>): Promise<Record<string, unknown>> {
  // provide a fake gondolin module so ensureVm() can run without a real package
  const actual = await importOriginal<typeof import("@earendil-works/gondolin")>();
  const fakeVms = new Map<string, FakeVm>();

  return {
    // Re-export VFS utilities needed by SizeLimitProvider
    VirtualProviderClass: actual.VirtualProviderClass,
    ERRNO: actual.ERRNO,
    isWriteFlag: actual.isWriteFlag,
    __fakeVms: fakeVms,
    /** Last VMOptions passed to VM.create — for mount assertions. */
    __lastVmOptions: { value: null as unknown },
    VM: {
      create: vi.fn(async (opts: unknown) => {
        const gondolin = await import("@earendil-works/gondolin");
        // @ts-expect-error test-only
        gondolin.__lastVmOptions.value = opts;
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
      rootPath: string;
      constructor(path: string) { this.rootPath = path; }
    },
    ReadonlyProvider: class {
      backend: unknown;
      constructor(backend: unknown) { this.backend = backend; }
    },
    MemoryProvider: class {
      _files = new Map<string, string>();
      _readOnly = false;
      _instance: { files: Map<string, string>; readOnly: boolean };
      constructor() {
        this._instance = { files: this._files, readOnly: false };
        memoryProviderInstances.push(this._instance);
      }
      mkdirSync(_path: string, _opts?: object) {}
      writeFileSync(path: string, content: string, _opts?: object) {
        this._files.set(path, content);
      }
      setReadOnly() {
        this._readOnly = true;
        this._instance.readOnly = true;
      }
    },
    createHttpHooks: vi.fn((options?: { secrets?: Record<string, { value: string; hosts: string[] }> }) => ({
      httpHooks: {},
      env: Object.fromEntries(
        Object.keys(options?.secrets ?? {}).map((name, index) => [name, `GONDOLIN_SECRET_${index}_${name}`]),
      ),
    })),
  };
}

// Helper: register the next fake VM to be returned by VM.create
export async function registerFakeVm(vm: FakeVm) {
  const gondolin = await import("@earendil-works/gondolin");
  // @ts-expect-error test-only
  gondolin.__fakeVms.set("__next", vm);
}

export async function getLastVmOptions<T = { env?: Record<string, string> }>() {
  const gondolin = await import("@earendil-works/gondolin");
  // @ts-expect-error test-only
  return gondolin.__lastVmOptions.value as T;
}

export async function getLastCreateHttpHooksOptions<T = unknown>() {
  const gondolin = await import("@earendil-works/gondolin");
  return (gondolin.createHttpHooks as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)?.[0] as T;
}

export async function warmVm(tools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>) {
  const bashTool = tools.find((tool) => tool.name === "bash");
  if (!bashTool) {
    throw new Error("bash tool not found");
  }
  await bashTool.execute("warm-vm", { command: "echo hi" }, new AbortController().signal, () => {});
}

export const ARC = "test-arc";
export const gondolinConfig = {
  enabled: true,
  bashTimeoutSeconds: 30,
  blockedCidrs: [],
  dnsMode: "synthetic" as const,
};

export function makeLogger(): Record<"debug" | "info" | "warn" | "error", Mock> {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** Forget what the previous test registered and recorded. */
export async function resetGondolinMock(): Promise<void> {
  memoryProviderInstances.length = 0;
  const gondolin = await import("@earendil-works/gondolin");
  // @ts-expect-error test-only
  gondolin.__lastVmOptions.value = null;
}
