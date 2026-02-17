import { describe, it, expect } from "vitest";
import { compactJson, safeJson, truncateForDebug } from "../src/agent/debug-utils.js";

describe("debug-utils", () => {
  describe("safeJson leaf string truncation", () => {
    it("truncates leaf strings longer than 2048 chars with ellipsis in middle", () => {
      const long = "x".repeat(3000);
      const result = safeJson({ key: long }, 10000);
      const parsed = JSON.parse(result) as { key: string };
      expect(parsed.key.length).toBeLessThanOrEqual(2048);
      expect(parsed.key).toContain("...");
      expect(parsed.key.startsWith("x")).toBe(true);
      expect(parsed.key.endsWith("x")).toBe(true);
    });

    it("leaves short strings intact", () => {
      const result = safeJson({ key: "hello" }, 10000);
      expect(JSON.parse(result)).toEqual({ key: "hello" });
    });

    it("truncates nested leaf strings", () => {
      const long = "a".repeat(3000);
      const result = safeJson({ nested: { val: long } }, 10000);
      const parsed = JSON.parse(result) as { nested: { val: string } };
      expect(parsed.nested.val.length).toBeLessThanOrEqual(2048);
      expect(parsed.nested.val).toContain("...");
    });

    it("truncates strings in arrays", () => {
      const long = "b".repeat(3000);
      const result = safeJson([long], 10000);
      const parsed = JSON.parse(result) as string[];
      expect(parsed[0].length).toBeLessThanOrEqual(2048);
      expect(parsed[0]).toContain("...");
    });
  });

  describe("truncateForDebug", () => {
    it("returns short strings as-is", () => {
      expect(truncateForDebug("hello", 100)).toBe("hello");
    });

    it("truncates long strings", () => {
      const long = "z".repeat(200);
      const result = truncateForDebug(long, 50);
      expect(result.length).toBeLessThan(200);
      expect(result).toContain("truncated");
    });
  });

  describe("compactJson", () => {
    it("produces single-line output", () => {
      const result = compactJson({ a: 1, b: [2, 3] }, 1000);
      expect(result).toBe('{"a":1,"b":[2,3]}');
      expect(result).not.toContain("\n");
    });

    it("truncates long output", () => {
      const result = compactJson({ text: "x".repeat(500) }, 50);
      expect(result).toContain("truncated");
    });
  });
});
