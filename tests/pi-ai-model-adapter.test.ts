import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PiAiModelAdapter,
  PiAiModelResolutionError,
} from "../src/models/pi-ai-model-adapter.js";
import { RemoteModelCatalog } from "../src/models/remote-catalog.js";

describe("PiAiModelAdapter", () => {
  const adapter = new PiAiModelAdapter();

  it("resolves a known provider:model spec via pi-ai registry", () => {
    const resolved = adapter.resolve("openai:gpt-4o-mini");

    expect(resolved.spec.provider).toBe("openai");
    expect(resolved.spec.modelId).toBe("gpt-4o-mini");
    expect(resolved.model.provider).toBe("openai");
    expect(resolved.model.id).toBe("gpt-4o-mini");
  });

  it("resolves DeepSeek V4 Flash via pi-ai registry", () => {
    const resolved = adapter.resolve("deepseek:deepseek-v4-flash");
    const compat = resolved.model.compat as { thinkingFormat?: string } | undefined;

    expect(resolved.spec.provider).toBe("deepseek");
    expect(resolved.model.id).toBe("deepseek-v4-flash");
    expect(resolved.model.provider).toBe("deepseek");
    expect(resolved.model.api).toBe("openai-completions");
    expect(resolved.model.baseUrl).toBe("https://api.deepseek.com");
    expect(compat?.thinkingFormat).toBe("deepseek");
    expect(resolved.model.reasoning).toBe(true);
  });

  it("resolves DeepSeek V4 Pro with current pricing and limits", () => {
    const resolved = adapter.resolve("deepseek:deepseek-v4-pro");
    const compat = resolved.model.compat as { thinkingFormat?: string } | undefined;

    expect(resolved.spec.provider).toBe("deepseek");
    expect(resolved.model.id).toBe("deepseek-v4-pro");
    expect(resolved.model.provider).toBe("deepseek");
    expect(resolved.model.api).toBe("openai-completions");
    expect(resolved.model.baseUrl).toBe("https://api.deepseek.com");
    expect(compat?.thinkingFormat).toBe("deepseek");
    expect(resolved.model.reasoning).toBe(true);
    expect(resolved.model.cost.input).toBe(0.435);
    expect(resolved.model.cost.output).toBe(0.87);
    expect(resolved.model.cost.cacheRead).toBe(0.003625);
    expect(resolved.model.contextWindow).toBe(1_000_000);
    expect(resolved.model.maxTokens).toBe(384_000);
  });

  it("throws explicit error for unknown provider", () => {
    expect(() => adapter.resolve("nonexistent-provider:model")).toThrow(PiAiModelResolutionError);
    expect(() => adapter.resolve("nonexistent-provider:model")).toThrow("Unknown provider");
  });

  it("throws explicit error for unknown model under a known provider", () => {
    expect(() => adapter.resolve("openai:not-a-real-model")).toThrow(PiAiModelResolutionError);
    expect(() => adapter.resolve("openai:not-a-real-model")).toThrow("Unknown model");
  });

  it("resolves known openrouter model via static registry", () => {
    const resolved = adapter.resolve("openrouter:openrouter/auto");

    expect(resolved.spec.provider).toBe("openrouter");
    expect(resolved.model.provider).toBe("openrouter");
    expect(resolved.model.api).toBe("openai-completions");
  });

  it("resolves unknown openrouter model via dynamic fallback (zero-cost if cache not ready)", () => {
    // In tests the background fetch may not have landed; either way the model must resolve.
    // Note: digit-hyphen-digit normalization converts 3-1 to 3.1 in the fallback ID.
    const resolved = adapter.resolve("openrouter:google/gemini-3-1-pro-preview");

    expect(resolved.spec.provider).toBe("openrouter");
    expect(resolved.model.provider).toBe("openrouter");
    expect(resolved.model.id).toBe("google/gemini-3.1-pro-preview");
    expect(resolved.model.api).toBe("openai-completions");
    expect(resolved.model.baseUrl).toBe("https://openrouter.ai/api/v1");
  });
});

describe("RemoteModelCatalog", () => {
  /**
   * A model id pi-ai will never bake into its static catalog, standing in for
   * the real motivating case (`anthropic:claude-opus-5`, published by pi.dev
   * long before the pinned pi-ai release knew about it).
   */
  const NEW_MODEL = {
    id: "claude-muaddib-test-9",
    name: "Claude Muaddib Test 9",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  };

  const tempDirs: string[] = [];
  let cachePath: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "muaddib-catalog-"));
    tempDirs.push(dir);
    cachePath = join(dir, "models-store.json");
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
  });

  function catalogResponse(models: unknown[], init: ResponseInit = {}): Response {
    return new Response(JSON.stringify({ models }), {
      status: 200,
      headers: { "last-modified": "Fri, 24 Jul 2026 22:00:00 GMT" },
      ...init,
    });
  }

  function catalog(fetchImpl: unknown, now?: () => number): RemoteModelCatalog {
    return new RemoteModelCatalog({ fetchImpl: fetchImpl as typeof fetch, now });
  }

  it("serves models published after the static pi-ai catalog was baked", async () => {
    const models = builtinModels();
    expect(models.getModel("anthropic", NEW_MODEL.id)).toBeUndefined();

    const fetchImpl = vi.fn(async () => catalogResponse([NEW_MODEL]));
    const remote = catalog(fetchImpl);
    remote.attach(models);

    const result = await remote.refresh(["anthropic"], { cachePath });

    expect(result.fetched).toEqual(["anthropic"]);
    expect(result.aborted).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://pi.dev/api/models/providers/anthropic"),
      expect.anything(),
    );
    const resolved = models.getModel("anthropic", NEW_MODEL.id);
    expect(resolved?.cost.input).toBe(5);
    expect(resolved?.contextWindow).toBe(1_000_000);
    // Static entries stay resolvable alongside the overlay.
    expect(models.getModel("anthropic", "claude-opus-4-5")).toBeDefined();
  });

  it("overrides stale static entries by model id", async () => {
    const models = builtinModels();
    const staticModel = models.getModel("anthropic", "claude-opus-4-5");
    expect(staticModel).toBeDefined();

    const remote = catalog(async () =>
      catalogResponse([{ ...staticModel, cost: { ...staticModel!.cost, input: 42 } }]),
    );
    remote.attach(models);
    await remote.refresh(["anthropic"], { cachePath });

    expect(models.getModel("anthropic", "claude-opus-4-5")?.cost.input).toBe(42);
  });

  it("keeps the static entry when the remote model is incomplete", async () => {
    const models = builtinModels();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Only an id: replacing the static model with this would strip api/baseUrl/cost.
    const remote = catalog(async () => catalogResponse([{ id: "claude-opus-4-5" }, NEW_MODEL]));
    remote.attach(models);
    await remote.refresh(["anthropic"], { cachePath });

    expect(models.getModel("anthropic", "claude-opus-4-5")?.baseUrl).toBe("https://api.anthropic.com");
    expect(models.getModel("anthropic", NEW_MODEL.id)).toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("persists the catalog and restores it without network access", async () => {
    await catalog(async () => catalogResponse([NEW_MODEL])).refresh(["anthropic"], { cachePath });

    const persisted = JSON.parse(await readFile(cachePath, "utf8")) as Record<string, { models: unknown[] }>;
    expect(persisted.anthropic.models).toHaveLength(1);

    const models = builtinModels();
    const reader = catalog(() => {
      throw new Error("network must not be used");
    });
    reader.attach(models);
    await reader.load(cachePath);

    expect(models.getModel("anthropic", NEW_MODEL.id)).toBeDefined();
  });

  it("skips the network while a cached entry is fresh, and refetches once stale", async () => {
    const fetchImpl = vi.fn(async () => catalogResponse([NEW_MODEL]));
    let now = 1_000_000;
    const clock = () => now;

    await catalog(fetchImpl, clock).refresh(["anthropic"], { cachePath });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 3 * 60 * 60 * 1000;
    const fresh = await catalog(fetchImpl, clock).refresh(["anthropic"], { cachePath });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fresh.fetched).toEqual([]);

    now += 2 * 60 * 60 * 1000;
    const stale = await catalog(fetchImpl, clock).refresh(["anthropic"], { cachePath });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(stale.fetched).toEqual(["anthropic"]);
  });

  it("records providers that have no remote catalog instead of refetching them", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));

    const first = await catalog(fetchImpl).refresh(["llama"], { cachePath });
    expect(first.errors.size).toBe(0);
    expect(first.fetched).toEqual([]);

    await catalog(fetchImpl).refresh(["llama"], { cachePath });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports per-provider failures without dropping healthy providers", async () => {
    const fetchImpl = vi.fn(async (url: URL) =>
      url.pathname.endsWith("anthropic")
        ? catalogResponse([NEW_MODEL])
        : new Response("boom", { status: 500 }),
    );
    const models = builtinModels();
    const remote = catalog(fetchImpl);
    remote.attach(models);

    const result = await remote.refresh(["anthropic", "openai"], { cachePath });

    expect(result.fetched).toEqual(["anthropic"]);
    expect(result.errors.get("openai")?.message).toContain("500");
    expect(models.getModel("anthropic", NEW_MODEL.id)).toBeDefined();
  });

  it("keeps the cached catalog when the response payload is unusable", async () => {
    await catalog(async () => catalogResponse([NEW_MODEL])).refresh(["anthropic"], { cachePath });

    const models = builtinModels();
    const remote = catalog(async () => new Response("42", { status: 200 }));
    remote.attach(models);
    const result = await remote.refresh(["anthropic"], { cachePath, force: true });

    expect(result.errors.get("anthropic")?.message).toContain("unexpected shape");
    expect(models.getModel("anthropic", NEW_MODEL.id)).toBeDefined();
  });

  it("reports an aborted refresh instead of claiming success", async () => {
    const controller = new AbortController();
    const remote = catalog(async () => {
      controller.abort();
      throw new Error("aborted");
    });

    const result = await remote.refresh(["anthropic"], { cachePath, signal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(result.errors.size).toBe(0);
  });

  it("starts from scratch when the cache file is corrupt", async () => {
    await writeFile(cachePath, "{not json", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const models = builtinModels();
    const remote = catalog(async () => catalogResponse([NEW_MODEL]));
    remote.attach(models);
    await remote.refresh(["anthropic"], { cachePath });

    expect(warn).toHaveBeenCalled();
    expect(models.getModel("anthropic", NEW_MODEL.id)).toBeDefined();
    warn.mockRestore();
  });
});
