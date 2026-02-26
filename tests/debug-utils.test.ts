import { describe, it, expect } from "vitest";
import { compactJson, safeJson, stripBinaryContent, truncateForDebug } from "../src/agent/debug-utils.js";

describe("debug-utils", () => {
  describe("stripBinaryContent", () => {
    it("replaces image data with placeholder and preview", () => {
      const data = "iVBORw0KGgoAAAAN" + "A".repeat(2000);
      const result = stripBinaryContent({
        type: "image",
        data,
        mimeType: "image/png",
      }) as Record<string, unknown>;

      expect(result.type).toBe("image");
      expect(result.mimeType).toBe("image/png");
      const replaced = result.data as string;
      expect(replaced).toContain("[binary image data, image/png]");
      // Preview of first 512 chars
      expect(replaced).toContain(data.slice(0, 512));
      // Full data must not be present
      expect(replaced).not.toBe(data);
      expect(replaced.length).toBeLessThan(data.length);
    });

    it("leaves short image data with preview (no truncation marker)", () => {
      const data = "abc123";
      const result = stripBinaryContent({
        type: "image",
        data,
        mimeType: "image/gif",
      }) as Record<string, unknown>;

      expect(result.data).toBe("[binary image data, image/gif] abc123");
    });

    it("recurses into nested objects and arrays", () => {
      const data = "X".repeat(1000);
      const input = {
        content: [
          { type: "text", text: "hello" },
          { type: "image", data, mimeType: "image/jpeg" },
        ],
      };
      const result = input.content[1].data;
      const stripped = stripBinaryContent(input) as any;
      expect(stripped.content[0]).toEqual({ type: "text", text: "hello" });
      expect(stripped.content[1].data).not.toBe(result);
      expect(stripped.content[1].data).toContain("[binary image data, image/jpeg]");
    });

    it("passes through primitives unchanged", () => {
      expect(stripBinaryContent(null)).toBe(null);
      expect(stripBinaryContent(undefined)).toBe(undefined);
      expect(stripBinaryContent(42)).toBe(42);
      expect(stripBinaryContent("hello")).toBe("hello");
    });

    it("does not affect non-image objects with data field", () => {
      const obj = { type: "file", data: "some content" };
      expect(stripBinaryContent(obj)).toEqual(obj);
    });

    it("replaces image_url with base64 data: URL with placeholder and preview", () => {
      const dataUrl = "data:image/png;base64," + "A".repeat(2000);
      const result = stripBinaryContent({
        type: "image_url",
        image_url: { url: dataUrl },
      }) as Record<string, any>;

      expect(result.type).toBe("image_url");
      expect(result.image_url.url).toContain("[base64 data url]");
      expect(result.image_url.url).toContain(dataUrl.slice(0, 512));
      expect(result.image_url.url).not.toBe(dataUrl);
      expect(result.image_url.url.length).toBeLessThan(dataUrl.length);
    });

    it("leaves image_url with short data: URL (no truncation marker)", () => {
      const dataUrl = "data:image/gif;base64,R0lGOD";
      const result = stripBinaryContent({
        type: "image_url",
        image_url: { url: dataUrl },
      }) as Record<string, any>;

      expect(result.image_url.url).toBe(`[base64 data url] ${dataUrl}`);
    });

    it("does not strip image_url with regular https URL", () => {
      const obj = {
        type: "image_url",
        image_url: { url: "https://example.com/image.png" },
      };
      const result = stripBinaryContent(obj) as Record<string, any>;
      expect(result.image_url.url).toBe("https://example.com/image.png");
    });

    it("recurses into arrays containing image_url blocks", () => {
      const dataUrl = "data:image/png;base64," + "B".repeat(1000);
      const input = {
        content: [
          { type: "text", text: "hello" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      };
      const stripped = stripBinaryContent(input) as any;
      expect(stripped.content[0]).toEqual({ type: "text", text: "hello" });
      expect(stripped.content[1].image_url.url).toContain("[base64 data url]");
      expect(stripped.content[1].image_url.url).not.toBe(dataUrl);
    });
  });

  describe("safeJson", () => {
    it("strips binary content before serializing", () => {
      const data = "B".repeat(2000);
      const result = safeJson(
        { content: [{ type: "image", data, mimeType: "image/png" }] },
        100000,
      );
      expect(result).not.toContain("B".repeat(2000));
      expect(result).toContain("[binary image data, image/png]");
    });

    it("preserves long text strings without leaf truncation", () => {
      const long = "x".repeat(3000);
      const result = safeJson({ key: long }, 100000);
      const parsed = JSON.parse(result) as { key: string };
      expect(parsed.key).toBe(long);
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
