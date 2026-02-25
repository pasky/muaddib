import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RealFSProvider, type VirtualProvider } from "@earendil-works/gondolin";
import { SizeLimitProvider } from "../src/agent/tools/size-limit-provider.js";

function createTestProvider(limitBytes: number): { provider: SizeLimitProvider; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "slp-test-"));
  const backend = new RealFSProvider(dir) as VirtualProvider;
  const provider = new SizeLimitProvider(backend, limitBytes, dir);
  return { provider, dir };
}

describe("SizeLimitProvider", () => {
  let provider: SizeLimitProvider;
  let dir: string;

  // 100 KB limit — large enough to absorb dir metadata overhead from `du`.
  const LIMIT = 102400;

  beforeEach(() => {
    ({ provider, dir } = createTestProvider(LIMIT));
  });

  it("allows writes within the limit", async () => {
    const data = Buffer.alloc(5000, 0x41);
    await provider.writeFile!("/test.bin", data);
    const content = await provider.readFile!("/test.bin");
    expect(Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content as string)).toBe(5000);
  });

  it("throws ENOSPC when write exceeds limit", async () => {
    const remaining = provider.remainingBytes;
    // Fill most of the budget
    await provider.writeFile!("/a.bin", Buffer.alloc(remaining - 1000));
    // Next write exceeds remaining budget
    await expect(provider.writeFile!("/b.bin", Buffer.alloc(2000)))
      .rejects.toMatchObject({ code: "ENOSPC" });
  });

  it("delete frees budget and allows more writes", async () => {
    const remaining = provider.remainingBytes;
    const fillSize = remaining - 1000;
    await provider.writeFile!("/a.bin", Buffer.alloc(fillSize));

    // This should fail — only ~1000 bytes left
    await expect(provider.writeFile!("/b.bin", Buffer.alloc(2000)))
      .rejects.toMatchObject({ code: "ENOSPC" });

    // Delete the big file to reclaim space
    await provider.unlink("/a.bin");

    // Now the write should succeed
    await provider.writeFile!("/b.bin", Buffer.alloc(2000));
  });

  it("truncate down frees budget", async () => {
    const remaining = provider.remainingBytes;
    await provider.writeFile!("/big.bin", Buffer.alloc(remaining - 500));

    // Almost full — 2 KB more would exceed
    await expect(provider.writeFile!("/extra.bin", Buffer.alloc(2000)))
      .rejects.toMatchObject({ code: "ENOSPC" });

    // Truncate big file down to 1000 bytes
    const handle = await provider.open("/big.bin", "r+");
    await handle.truncate(1000);
    await handle.close();

    // Now we have plenty of room
    await provider.writeFile!("/extra.bin", Buffer.alloc(2000));
  });

  it("read-only operations pass through", async () => {
    writeFileSync(join(dir, "hello.txt"), "world");

    const content = await provider.readFile!("/hello.txt", "utf8");
    expect(content).toBe("world");

    const st = await provider.stat("/hello.txt");
    expect(st.size).toBe(5);

    const entries = await provider.readdir("/");
    expect(entries).toContain("hello.txt");
  });

  it("writeFileSync throws ENOSPC", () => {
    expect(() => provider.writeFileSync!("/big.bin", Buffer.alloc(LIMIT + 10000)))
      .toThrow(expect.objectContaining({ code: "ENOSPC" }));
  });

  it("appendFile tracks added bytes", async () => {
    const remaining = provider.remainingBytes;
    await provider.writeFile!("/log.txt", Buffer.alloc(remaining - 3000));
    await provider.appendFile!("/log.txt", Buffer.alloc(2000));
    // Only ~1000 bytes left; another 2000 should fail
    await expect(provider.appendFile!("/log.txt", Buffer.alloc(2000)))
      .rejects.toMatchObject({ code: "ENOSPC" });
  });

  it("handle write tracks bytes", async () => {
    const remaining = provider.remainingBytes;
    const handle = await provider.open("/data.bin", "w");
    const buf = Buffer.alloc(remaining - 1000, 0x42);
    await handle.write(buf, 0, buf.length);
    await handle.close();

    // Only ~1000 bytes left; 5000 more should fail
    await expect(provider.writeFile!("/more.bin", Buffer.alloc(5000)))
      .rejects.toMatchObject({ code: "ENOSPC" });
  });

  it("overwrite of existing file accounts for old size", async () => {
    const remaining = provider.remainingBytes;
    // Write a big file
    await provider.writeFile!("/data.bin", Buffer.alloc(remaining - 2000));
    // Overwrite with a much smaller file — delta is negative, always allowed
    await provider.writeFile!("/data.bin", Buffer.alloc(2048));
    // Freed most of the budget; a new large write should succeed
    await provider.writeFile!("/extra.bin", Buffer.alloc(remaining - 10000));
  });

  it("measures baseline from existing host dir contents", () => {
    const d = mkdtempSync(join(tmpdir(), "slp-base-"));
    mkdirSync(join(d, "sub"), { recursive: true });
    writeFileSync(join(d, "sub", "existing.bin"), Buffer.alloc(50000));
    const backend = new RealFSProvider(d) as VirtualProvider;
    // 60 KB limit with ~50 KB already on disk
    const p = new SizeLimitProvider(backend, 61440, d);
    expect(p.usedBytes).toBeGreaterThan(40000);
    // Writing 20 KB should fail (baseline ~54 KB + 20 KB > 60 KB)
    expect(() => p.writeFileSync!("/big.bin", Buffer.alloc(20480)))
      .toThrow(expect.objectContaining({ code: "ENOSPC" }));
  });

  it("statfs reports limit and free space", async () => {
    await provider.writeFile!("/some.bin", Buffer.alloc(4096));
    const sf = await provider.statfs("/");
    expect(sf.bsize).toBe(4096);
    // Total should reflect limitBytes / bsize
    expect(sf.blocks).toBe(Math.floor(LIMIT / 4096));
    // Free should be less than total
    expect(sf.bfree).toBeLessThan(sf.blocks);
    expect(sf.bavail).toBe(sf.bfree);
  });

  it("unlinkSync reclaims space", () => {
    const remaining = provider.remainingBytes;
    provider.writeFileSync!("/a.bin", Buffer.alloc(remaining - 1000));
    expect(() => provider.writeFileSync!("/b.bin", Buffer.alloc(2000)))
      .toThrow(expect.objectContaining({ code: "ENOSPC" }));
    provider.unlinkSync("/a.bin");
    provider.writeFileSync!("/b.bin", Buffer.alloc(2000));
  });
});
