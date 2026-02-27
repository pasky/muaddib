import { describe, it, expect } from "vitest";
import { ArcLockManager } from "../src/utils/arc-lock.js";

describe("ArcLockManager", () => {
  it("serialises calls for the same arc key", async () => {
    const lock = new ArcLockManager();
    const order: number[] = [];

    const first = lock.run("a", async () => {
      await delay(30);
      order.push(1);
      return "first";
    });

    const second = lock.run("a", async () => {
      order.push(2);
      return "second";
    });

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toBe("first");
    expect(r2).toBe("second");
    expect(order).toEqual([1, 2]);
  });

  it("allows different arc keys to run concurrently", async () => {
    const lock = new ArcLockManager();
    const order: string[] = [];

    const a = lock.run("a", async () => {
      await delay(30);
      order.push("a");
    });

    const b = lock.run("b", async () => {
      order.push("b");
    });

    await Promise.all([a, b]);
    // "b" should finish before "a" since they run concurrently
    expect(order).toEqual(["b", "a"]);
  });

  it("releases the lock even when fn throws", async () => {
    const lock = new ArcLockManager();

    await expect(lock.run("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");

    // Should still be able to acquire the lock
    const result = await lock.run("a", async () => "ok");
    expect(result).toBe("ok");
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
