/**
 * NotifyingProvider — VFS provider wrapper that calls callbacks on write/unlink.
 *
 * Wraps a backend VirtualProvider (typically SizeLimitProvider wrapping
 * RealFSProvider) and invokes onWrite/onDelete callbacks synchronously with
 * the filesystem operation.  This replaces fs.watch() entirely — notifications
 * are immediate and platform-independent.
 */

import { basename } from "node:path";

import {
  VirtualProviderClass,
  type VirtualProvider,
  type VirtualFileHandle,
  type VfsStatfs,
} from "@earendil-works/gondolin";

export class NotifyingProvider extends VirtualProviderClass implements VirtualProvider {
  constructor(
    private readonly backend: VirtualProvider,
    private readonly onWrite: (name: string) => void,
    private readonly onDelete: (name: string) => void,
  ) {
    super();
  }

  // ── Notification helpers ──────────────────────────────────────────────

  private notifyWrite(path: string): void {
    const name = basename(path);
    if (name.endsWith(".json")) this.onWrite(name);
  }

  private notifyDelete(path: string): void {
    const name = basename(path);
    if (name.endsWith(".json")) this.onDelete(name);
  }

  // ── VirtualProvider properties ────────────────────────────────────────

  get readonly(): boolean { return false; }
  get supportsSymlinks(): boolean { return this.backend.supportsSymlinks; }
  get supportsWatch(): boolean { return this.backend.supportsWatch; }

  // ── Read-only passthrough ─────────────────────────────────────────────

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

  async readFile(path: string, options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<Buffer | string> {
    if (this.backend.readFile) return this.backend.readFile(path, options);
    return super.readFile!(path, options);
  }
  readFileSync(path: string, options?: { encoding?: BufferEncoding } | BufferEncoding): Buffer | string {
    if (this.backend.readFileSync) return this.backend.readFileSync(path, options);
    return super.readFileSync!(path, options);
  }

  async exists(path: string): Promise<boolean> {
    if (this.backend.exists) return this.backend.exists(path);
    return super.exists!(path);
  }
  existsSync(path: string): boolean {
    if (this.backend.existsSync) return this.backend.existsSync(path);
    return super.existsSync!(path);
  }

  async statfs(path: string): Promise<VfsStatfs> {
    if (this.backend.statfs) return this.backend.statfs(path);
    return super.statfs!(path);
  }

  // ── Write methods with notification ───────────────────────────────────

  async writeFile(path: string, data: Buffer | string, options?: { encoding?: BufferEncoding; mode?: number }): Promise<void> {
    if (this.backend.writeFile) {
      await this.backend.writeFile(path, data, options);
    } else {
      const handle = await this.backend.open(path, "w", options?.mode);
      try { await handle.writeFile(data, options); } finally { await handle.close(); }
    }
    this.notifyWrite(path);
  }

  writeFileSync(path: string, data: Buffer | string, options?: { encoding?: BufferEncoding; mode?: number }): void {
    if (this.backend.writeFileSync) {
      this.backend.writeFileSync(path, data, options);
    } else {
      const handle = this.backend.openSync(path, "w", options?.mode);
      try { handle.writeFileSync(data, options); } finally { handle.closeSync(); }
    }
    this.notifyWrite(path);
  }

  async appendFile(path: string, data: Buffer | string, options?: { encoding?: BufferEncoding; mode?: number }): Promise<void> {
    if (this.backend.appendFile) {
      await this.backend.appendFile(path, data, options);
    } else {
      const handle = await this.backend.open(path, "a", options?.mode);
      try { await handle.writeFile(data, options); } finally { await handle.close(); }
    }
    this.notifyWrite(path);
  }

  appendFileSync(path: string, data: Buffer | string, options?: { encoding?: BufferEncoding; mode?: number }): void {
    if (this.backend.appendFileSync) {
      this.backend.appendFileSync(path, data, options);
    } else {
      const handle = this.backend.openSync(path, "a", options?.mode);
      try { handle.writeFileSync(data, options); } finally { handle.closeSync(); }
    }
    this.notifyWrite(path);
  }

  async copyFile(src: string, dest: string, mode?: number): Promise<void> {
    if (this.backend.copyFile) {
      await this.backend.copyFile(src, dest, mode);
    } else {
      await super.copyFile!(src, dest, mode);
    }
    this.notifyWrite(dest);
  }

  copyFileSync(src: string, dest: string, mode?: number): void {
    if (this.backend.copyFileSync) {
      this.backend.copyFileSync(src, dest, mode);
    } else {
      super.copyFileSync!(src, dest, mode);
    }
    this.notifyWrite(dest);
  }

  // ── Delete methods with notification ──────────────────────────────────

  async unlink(path: string): Promise<void> {
    await this.backend.unlink(path);
    this.notifyDelete(path);
  }

  unlinkSync(path: string): void {
    this.backend.unlinkSync(path);
    this.notifyDelete(path);
  }

  // ── Passthrough writes (no notification needed for mkdir/rename/link) ─

  async mkdir(path: string, options?: object) { return this.backend.mkdir(path, options); }
  mkdirSync(path: string, options?: object) { return this.backend.mkdirSync(path, options); }
  async rename(oldPath: string, newPath: string) {
    await this.backend.rename(oldPath, newPath);
    // rename is like delete old + write new
    this.notifyDelete(oldPath);
    this.notifyWrite(newPath);
  }
  renameSync(oldPath: string, newPath: string) {
    this.backend.renameSync(oldPath, newPath);
    this.notifyDelete(oldPath);
    this.notifyWrite(newPath);
  }

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

  async rmdir(path: string): Promise<void> { return this.backend.rmdir(path); }
  rmdirSync(path: string): void { return this.backend.rmdirSync(path); }

  // ── Open: wrap write handles for notification ─────────────────────────

  async open(path: string, flags: string, mode?: number): Promise<VirtualFileHandle> {
    const handle = await this.backend.open(path, flags, mode);
    // For write-mode opens, we notify on close.
    if (isWriteLikeFlag(flags)) {
      return wrapHandleForNotify(handle, () => this.notifyWrite(path));
    }
    return handle;
  }

  openSync(path: string, flags: string, mode?: number): VirtualFileHandle {
    const handle = this.backend.openSync(path, flags, mode);
    if (isWriteLikeFlag(flags)) {
      return wrapHandleForNotify(handle, () => this.notifyWrite(path));
    }
    return handle;
  }

  // ── Watch (passthrough) ───────────────────────────────────────────────

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

  // ── Close ─────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    const backend = this.backend as VirtualProvider & { close?(): Promise<void> };
    if (backend.close) await backend.close();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isWriteLikeFlag(flags: string): boolean {
  return flags.includes("w") || flags.includes("a") || flags.includes("+");
}

/**
 * Wrap a file handle so that close() fires a notification callback.
 * This ensures that writes through open()/handle.writeFile() are caught.
 */
function wrapHandleForNotify(
  handle: VirtualFileHandle,
  notify: () => void,
): VirtualFileHandle {
  return {
    read: handle.read.bind(handle),
    readSync: handle.readSync.bind(handle),
    readFile: handle.readFile.bind(handle),
    readFileSync: handle.readFileSync.bind(handle),
    stat: handle.stat.bind(handle),
    statSync: handle.statSync.bind(handle),
    write: handle.write.bind(handle),
    writeSync: handle.writeSync.bind(handle),
    writeFile: handle.writeFile.bind(handle),
    writeFileSync: handle.writeFileSync.bind(handle),
    truncate: handle.truncate.bind(handle),
    truncateSync: handle.truncateSync.bind(handle),
    async close() {
      await handle.close();
      notify();
    },
    closeSync() {
      handle.closeSync();
      notify();
    },
    get path() { return handle.path; },
    get flags() { return handle.flags; },
    get mode() { return handle.mode; },
    get position() { return handle.position; },
    get closed() { return handle.closed; },
  };
}
