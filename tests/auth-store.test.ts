import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuthStore, loadCredentialsFile, saveCredentialsFile } from "../src/auth/auth-store.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "muaddib-auth-store-"));
}

describe("loadCredentialsFile / saveCredentialsFile", () => {
  it("round-trips credentials and creates parent directories with 0600 mode", () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, "nested", "auth.json");
      saveCredentialsFile(path, { jina: { type: "api_key", key: "jina-key" } });
      expect(loadCredentialsFile(path)).toEqual({ jina: { type: "api_key", key: "jina-key" } });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty object for missing or empty files", () => {
    const dir = makeTempDir();
    try {
      expect(loadCredentialsFile(join(dir, "absent.json"))).toEqual({});
      const empty = join(dir, "empty.json");
      writeFileSync(empty, "\n");
      expect(loadCredentialsFile(empty)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on malformed content instead of silently defaulting", () => {
    const dir = makeTempDir();
    try {
      const corrupt = join(dir, "auth.json");
      writeFileSync(corrupt, "{not json");
      expect(() => loadCredentialsFile(corrupt)).toThrow(/Failed to parse/);
      const array = join(dir, "array.json");
      writeFileSync(array, "[]");
      expect(() => loadCredentialsFile(array)).toThrow(/JSON object/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AuthStore", () => {
  it("file-backed store persists modify/delete across instances", async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, "auth.json");
      const store = AuthStore.create(path);
      await store.credentials.modify("openrouter", async () => ({ type: "api_key", key: "or-key" }));
      expect(await store.getApiKey("openrouter")).toBe("or-key");

      const reopened = AuthStore.create(path);
      expect(await reopened.credentials.read("openrouter")).toEqual({ type: "api_key", key: "or-key" });
      expect(await reopened.credentials.list()).toEqual([{ providerId: "openrouter", type: "api_key" }]);

      await reopened.credentials.delete("openrouter");
      expect(await store.credentials.read("openrouter")).toBeUndefined();
      expect(readFileSync(path, "utf8")).not.toContain("or-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("modify leaves the entry unchanged when fn returns undefined", async () => {
    const store = AuthStore.inMemory({ jina: { type: "api_key", key: "keep-me" } });
    const result = await store.credentials.modify("jina", async () => undefined);
    expect(result).toEqual({ type: "api_key", key: "keep-me" });
    expect(await store.credentials.read("jina")).toEqual({ type: "api_key", key: "keep-me" });
  });

  it("getApiKey resolves stored api_key credentials for non-model providers", async () => {
    const store = AuthStore.inMemory({
      jina: { type: "api_key", key: "jina-key" },
      "slack-T123": { type: "api_key", key: "xoxb-token" },
    });
    expect(await store.getApiKey("jina")).toBe("jina-key");
    expect(await store.getApiKey("slack-T123")).toBe("xoxb-token");
  });

  it("resolves configured key values on read like pi's AuthStorage did", async () => {
    process.env.MUADDIB_TEST_AUTH_KEY = "from-env";
    try {
      const store = AuthStore.inMemory({
        "env-ref": { type: "api_key", key: "$MUADDIB_TEST_AUTH_KEY" },
        "env-braced": { type: "api_key", key: "prefix-${MUADDIB_TEST_AUTH_KEY}" },
        "cred-env": { type: "api_key", key: "$LOCAL_ONLY", env: { LOCAL_ONLY: "from-cred-env" } },
        command: { type: "api_key", key: "!echo cmd-key" },
        escaped: { type: "api_key", key: "lit$$eral" },
        missing: { type: "api_key", key: "$MUADDIB_TEST_AUTH_UNSET" },
      });
      expect(await store.getApiKey("env-ref")).toBe("from-env");
      expect(await store.getApiKey("env-braced")).toBe("prefix-from-env");
      expect(await store.getApiKey("cred-env")).toBe("from-cred-env");
      expect(await store.getApiKey("command")).toBe("cmd-key");
      expect(await store.getApiKey("escaped")).toBe("lit$eral");
      expect(await store.credentials.read("missing")).toEqual({
        type: "api_key",
        key: undefined,
      });
    } finally {
      delete process.env.MUADDIB_TEST_AUTH_KEY;
    }
  });
});
