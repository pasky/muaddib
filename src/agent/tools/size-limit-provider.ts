/**
 * Size-limiting VFS provider wrapper.
 *
 * Delegates to a backend VirtualProvider while tracking net bytes written.
 * Throws ENOSPC when baseline + netBytes > limitBytes.  Deletes and
 * truncations reclaim budget.  Used to cap /workspace size in Gondolin VMs.
 */

import { execFileSync } from "node:child_process";
import { getSystemErrorName } from "node:util";

import {
  VirtualProviderClass,
  ERRNO,
  isWriteFlag,
  type VirtualProvider,
  type VirtualFileHandle,
  type VfsStatfs,
} from "@earendil-works/gondolin";

// ── Errno helper (createErrnoError is not in gondolin's public API) ────

function createEnospcError(syscall: string, path?: string): NodeJS.ErrnoException {
  // ERRNO values from gondolin are positive; getSystemErrorName expects negative.
  let code: string;
  try {
    code = getSystemErrorName(-ERRNO.ENOSPC);
  } catch {
    code = "ENOSPC";
  }
  const message = path
    ? `${code}: ${syscall} '${path}'`
    : `${code}: ${syscall}`;
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  error.errno = ERRNO.ENOSPC;
  error.syscall = syscall;
  if (path) error.path = path;
  return error;
}

// ── Baseline measurement ───────────────────────────────────────────────

function measureDirSizeBytes(dirPath: string): number {
  try {
    const output = execFileSync("du", ["-sk", dirPath], { encoding: "utf8" });
    const kb = parseInt(output.split("\t")[0]!, 10);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

// ── Size-tracking file handle wrapper ──────────────────────────────────

function wrapHandle(
  handle: VirtualFileHandle,
  provider: SizeLimitProvider,
  path: string | undefined,
): VirtualFileHandle {
  return {
    // ── read (passthrough) ──
    read: handle.read.bind(handle),
    readSync: handle.readSync.bind(handle),
    readFile: handle.readFile.bind(handle),
    readFileSync: handle.readFileSync.bind(handle),

    // ── stat (passthrough) ──
    stat: handle.stat.bind(handle),
    statSync: handle.statSync.bind(handle),

    // ── write ──
    async write(buffer: Buffer, offset: number, length: number, position?: number | null) {
      provider.checkBudget(length, "write", path);
      const result = await handle.write(buffer, offset, length, position);
      provider.addBytes(result.bytesWritten);
      return result;
    },
    writeSync(buffer: Buffer, offset: number, length: number, position?: number | null) {
      provider.checkBudget(length, "write", path);
      const written = handle.writeSync(buffer, offset, length, position);
      provider.addBytes(written);
      return written;
    },

    async writeFile(data: Buffer | string, options?: { encoding?: BufferEncoding }) {
      const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, options?.encoding ?? "utf8");
      provider.checkBudget(size, "write", path);
      await handle.writeFile(data, options);
      provider.addBytes(size);
    },
    writeFileSync(data: Buffer | string, options?: { encoding?: BufferEncoding }) {
      const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, options?.encoding ?? "utf8");
      provider.checkBudget(size, "write", path);
      handle.writeFileSync(data, options);
      provider.addBytes(size);
    },

    // ── truncate ──
    async truncate(len?: number) {
      const targetLen = len ?? 0;
      const st = await handle.stat();
      const delta = targetLen - st.size;
      if (delta > 0) provider.checkBudget(delta, "truncate", path);
      await handle.truncate(len);
      provider.addBytes(delta);
    },
    truncateSync(len?: number) {
      const targetLen = len ?? 0;
      const st = handle.statSync();
      const delta = targetLen - st.size;
      if (delta > 0) provider.checkBudget(delta, "truncate", path);
      handle.truncateSync(len);
      provider.addBytes(delta);
    },

    // ── lifecycle ──
    close: handle.close.bind(handle),
    closeSync: handle.closeSync.bind(handle),
    get path() { return handle.path; },
    get flags() { return handle.flags; },
    get mode() { return handle.mode; },
    get position() { return handle.position; },
    get closed() { return handle.closed; },
  };
}

// ── SizeLimitProvider ──────────────────────────────────────────────────

export class SizeLimitProvider extends VirtualProviderClass implements VirtualProvider {
  private readonly backend: VirtualProvider;
  private readonly limitBytes: number;
  private readonly baselineBytes: number;
  /** Net bytes added by writes (can go negative from deletes). */
  private netBytes = 0;

  constructor(backend: VirtualProvider, limitBytes: number, hostDirPath: string) {
    super();
    this.backend = backend;
    this.limitBytes = limitBytes;
    this.baselineBytes = measureDirSizeBytes(hostDirPath);
  }

  /** Current usage estimate. */
  get usedBytes(): number {
    return this.baselineBytes + this.netBytes;
  }

  get remainingBytes(): number {
    return Math.max(0, this.limitBytes - this.usedBytes);
  }

  /** Throw ENOSPC if adding `bytes` would exceed the limit. */
  checkBudget(bytes: number, syscall: string, path?: string): void {
    if (this.usedBytes + bytes > this.limitBytes) {
      throw createEnospcError(syscall, path);
    }
  }

  /** Adjust the running byte counter (negative values free space). */
  addBytes(delta: number): void {
    this.netBytes += delta;
  }

  // ── VirtualProvider properties ──

  get readonly(): boolean { return false; }
  get supportsSymlinks(): boolean { return this.backend.supportsSymlinks; }
  get supportsWatch(): boolean { return this.backend.supportsWatch; }

  // ── open: wrap handles for write-flagged opens ──

  async open(path: string, flags: string, mode?: number): Promise<VirtualFileHandle> {
    const handle = await this.backend.open(path, flags, mode);
    if (isWriteFlag(flags)) {
      return wrapHandle(handle, this, path);
    }
    return handle;
  }

  openSync(path: string, flags: string, mode?: number): VirtualFileHandle {
    const handle = this.backend.openSync(path, flags, mode);
    if (isWriteFlag(flags)) {
      return wrapHandle(handle, this, path);
    }
    return handle;
  }

  // ── Read-only passthrough ──

  async stat(path: string, options?: object) { return this.backend.stat(path, options); }
  statSync(path: string, options?: object) { return this.backend.statSync(path, options); }
  async lstat(path: string, options?: object) { return this.backend.lstat(path, options); }
  lstatSync(path: string, options?: object) { return this.backend.lstatSync(path, options); }
  async readdir(path: string, options?: object) { return this.backend.readdir(path, options); }
  readdirSync(path: string, options?: object) { return this.backend.readdirSync(path, options); }

  async readlink(path: string, options?: object): Promise<string> {
    return this.backend.readlink ? this.backend.readlink(path, options) : super.readlink!(path, options);
  }
  readlinkSync(path: string, options?: object): string {
    return this.backend.readlinkSync ? this.backend.readlinkSync(path, options) : super.readlinkSync!(path, options);
  }
  async realpath(path: string, options?: object): Promise<string> {
    return this.backend.realpath ? this.backend.realpath(path, options) : super.realpath!(path, options);
  }
  realpathSync(path: string, options?: object): string {
    return this.backend.realpathSync ? this.backend.realpathSync(path, options) : super.realpathSync!(path, options);
  }
  async access(path: string, mode?: number): Promise<void> {
    return this.backend.access ? this.backend.access(path, mode) : super.access!(path, mode);
  }
  accessSync(path: string, mode?: number): void {
    return this.backend.accessSync ? this.backend.accessSync(path, mode) : super.accessSync!(path, mode);
  }

  // ── statfs: report limit as total, remaining as free ──

  async statfs(_path: string): Promise<VfsStatfs> {
    const bsize = 4096;
    const totalBlocks = Math.floor(this.limitBytes / bsize);
    const usedBlocks = Math.floor(this.usedBytes / bsize);
    const freeBlocks = Math.max(0, totalBlocks - usedBlocks);
    return {
      bsize,
      frsize: bsize,
      blocks: totalBlocks,
      bfree: freeBlocks,
      bavail: freeBlocks,
      files: 1048576,
      ffree: 1048576,
      namelen: 255,
    };
  }

  // ── Write passthrough (mkdir, rename, link, symlink — no size tracking) ──

  async mkdir(path: string, options?: object) { return this.backend.mkdir(path, options); }
  mkdirSync(path: string, options?: object) { return this.backend.mkdirSync(path, options); }
  async rename(oldPath: string, newPath: string) { return this.backend.rename(oldPath, newPath); }
  renameSync(oldPath: string, newPath: string) { return this.backend.renameSync(oldPath, newPath); }

  async link(existingPath: string, newPath: string): Promise<void> {
    if (this.backend.link) return this.backend.link(existingPath, newPath);
    return super.link!(existingPath, newPath);
  }
  linkSync(existingPath: string, newPath: string): void {
    if (this.backend.linkSync) return this.backend.linkSync(existingPath, newPath);
    return super.linkSync!(existingPath, newPath);
  }
  async symlink(target: string, path: string, type?: string): Promise<void> {
    if (this.backend.symlink) return this.backend.symlink(target, path, type);
    return super.symlink!(target, path, type);
  }
  symlinkSync(target: string, path: string, type?: string): void {
    if (this.backend.symlinkSync) return this.backend.symlinkSync(target, path, type);
    return super.symlinkSync!(target, path, type);
  }

  // ── Provider-level write methods (size-tracked) ──

  async writeFile(path: string, data: Buffer | string, options?: { encoding?: BufferEncoding; mode?: number }): Promise<void> {
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, options?.encoding ?? "utf8");
    // Subtract old file size if it exists.
    let oldSize = 0;
    try { oldSize = (await this.backend.stat(path)).size; } catch { /* new file */ }
    const delta = size - oldSize;
    if (delta > 0) this.checkBudget(delta, "write", path);
    if (this.backend.writeFile) {
      await this.backend.writeFile(path, data, options);
    } else {
      const handle = await this.backend.open(path, "w", options?.mode);
      try { await handle.writeFile(data, options); } finally { await handle.close(); }
    }
    this.addBytes(delta);
  }

  writeFileSync(path: string, data: Buffer | string, options?: { encoding?: BufferEncoding; mode?: number }): void {
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, options?.encoding ?? "utf8");
    let oldSize = 0;
    try { oldSize = this.backend.statSync(path).size; } catch { /* new file */ }
    const delta = size - oldSize;
    if (delta > 0) this.checkBudget(delta, "write", path);
    if (this.backend.writeFileSync) {
      this.backend.writeFileSync(path, data, options);
    } else {
      const handle = this.backend.openSync(path, "w", options?.mode);
      try { handle.writeFileSync(data, options); } finally { handle.closeSync(); }
    }
    this.addBytes(delta);
  }

  async appendFile(path: string, data: Buffer | string, options?: { encoding?: BufferEncoding; mode?: number }): Promise<void> {
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, options?.encoding ?? "utf8");
    this.checkBudget(size, "write", path);
    if (this.backend.appendFile) {
      await this.backend.appendFile(path, data, options);
    } else {
      const handle = await this.backend.open(path, "a", options?.mode);
      try { await handle.writeFile(data, options); } finally { await handle.close(); }
    }
    this.addBytes(size);
  }

  appendFileSync(path: string, data: Buffer | string, options?: { encoding?: BufferEncoding; mode?: number }): void {
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, options?.encoding ?? "utf8");
    this.checkBudget(size, "write", path);
    if (this.backend.appendFileSync) {
      this.backend.appendFileSync(path, data, options);
    } else {
      const handle = this.backend.openSync(path, "a", options?.mode);
      try { handle.writeFileSync(data, options); } finally { handle.closeSync(); }
    }
    this.addBytes(size);
  }

  async copyFile(src: string, dest: string, mode?: number): Promise<void> {
    const srcSize = (await this.backend.stat(src)).size;
    let oldDestSize = 0;
    try { oldDestSize = (await this.backend.stat(dest)).size; } catch { /* new file */ }
    const delta = srcSize - oldDestSize;
    if (delta > 0) this.checkBudget(delta, "copyFile", dest);
    if (this.backend.copyFile) {
      await this.backend.copyFile(src, dest, mode);
    } else {
      const handle = await this.backend.open(src, "r");
      try {
        const content = await handle.readFile();
        await this.writeFile(dest, content as Buffer);
        // writeFile already tracked bytes, so undo our tracking here
        this.addBytes(-delta);
      } finally { await handle.close(); }
    }
    this.addBytes(delta);
  }

  copyFileSync(src: string, dest: string, mode?: number): void {
    const srcSize = this.backend.statSync(src).size;
    let oldDestSize = 0;
    try { oldDestSize = this.backend.statSync(dest).size; } catch { /* new file */ }
    const delta = srcSize - oldDestSize;
    if (delta > 0) this.checkBudget(delta, "copyFile", dest);
    if (this.backend.copyFileSync) {
      this.backend.copyFileSync(src, dest, mode);
    } else {
      const handle = this.backend.openSync(src, "r");
      try {
        const content = handle.readFileSync();
        this.writeFileSync(dest, content as Buffer);
        this.addBytes(-delta);
      } finally { handle.closeSync(); }
    }
    this.addBytes(delta);
  }

  // ── readFile (passthrough) ──

  async readFile(path: string, options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<Buffer | string> {
    if (this.backend.readFile) return this.backend.readFile(path, options);
    return super.readFile!(path, options);
  }
  readFileSync(path: string, options?: { encoding?: BufferEncoding } | BufferEncoding): Buffer | string {
    if (this.backend.readFileSync) return this.backend.readFileSync(path, options);
    return super.readFileSync!(path, options);
  }

  // ── exists (passthrough) ──

  async exists(path: string): Promise<boolean> {
    if (this.backend.exists) return this.backend.exists(path);
    return super.exists!(path);
  }
  existsSync(path: string): boolean {
    if (this.backend.existsSync) return this.backend.existsSync(path);
    return super.existsSync!(path);
  }

  // ── Delete methods (reclaim budget) ──

  async unlink(path: string): Promise<void> {
    let size = 0;
    try { size = (await this.backend.stat(path)).size; } catch { /* ignore */ }
    await this.backend.unlink(path);
    this.addBytes(-size);
  }

  unlinkSync(path: string): void {
    let size = 0;
    try { size = this.backend.statSync(path).size; } catch { /* ignore */ }
    this.backend.unlinkSync(path);
    this.addBytes(-size);
  }

  async rmdir(path: string): Promise<void> {
    return this.backend.rmdir(path);
  }
  rmdirSync(path: string): void {
    return this.backend.rmdirSync(path);
  }

  // ── Watch (passthrough) ──

  watch(path: string, options?: object) {
    return this.backend.watch?.(path, options) ?? super.watch!(path, options);
  }
  watchAsync(path: string, options?: object) {
    return this.backend.watchAsync?.(path, options) ?? super.watchAsync!(path, options);
  }
  watchFile(path: string, options?: object, listener?: (...args: unknown[]) => void) {
    return this.backend.watchFile?.(path, options, listener) ?? super.watchFile!(path, options);
  }
  unwatchFile(path: string, listener?: (...args: unknown[]) => void) {
    if (this.backend.unwatchFile) { this.backend.unwatchFile(path, listener); return; }
    super.unwatchFile!(path, listener);
  }

  // ── Close ──

  async close(): Promise<void> {
    const backend = this.backend as VirtualProvider & { close?(): Promise<void> };
    if (backend.close) await backend.close();
  }
}
