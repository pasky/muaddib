/**
 * pi.dev remote model catalog overlay.
 *
 * pi-ai ships a *static* per-provider model catalog baked in at package build
 * time, so any model released after the last pi-ai release (e.g.
 * `anthropic:claude-opus-5`) is unresolvable until a dependency bump lands.
 * pi-coding-agent avoids that by overlaying a live catalog fetched from
 * `https://pi.dev/api/models/providers/<providerId>` on top of the static list,
 * but that wrapper is package-internal (not reachable through its `exports`
 * map), so muaddib keeps its own equivalent here.
 *
 * The fetched catalog is persisted to `$MUADDIB_HOME/models-store.json` and
 * refetched at most every `REMOTE_CATALOG_REFRESH_INTERVAL_MS`, so restarts and
 * short-lived CLI runs resolve new models straight from disk.
 *
 * A catalog older than the baked-in one is ignored entirely (pi-coding-agent's
 * shadowing gate), so upgrading pi-ai can never be undone by a stale cache.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Api, Model, MutableModels, Provider } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";

export const PI_DEV_CATALOG_BASE_URL = "https://pi.dev";
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface CatalogEntry {
  models: readonly Model<Api>[];
  /** Unix ms of the last completed remote check (including empty results). */
  checkedAt: number;
  /** Unix ms from the catalog response's `Last-Modified` header, 0 when absent. */
  lastModified: number;
}

export interface RemoteModelCatalogOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Generation timestamp of pi-ai's baked catalog; remote entries no newer than
   * this are ignored so an upgraded pi-ai is never shadowed by a stale cache.
   */
  builtinGeneratedAt?: number;
}

export interface RemoteCatalogRefreshResult {
  /** Providers whose catalog was (re)fetched with at least one model. */
  fetched: string[];
  /** Total models currently overlaid across all providers. */
  models: number;
  errors: Map<string, Error>;
  /** True when the refresh budget ran out before every provider was checked. */
  aborted: boolean;
}

export interface RemoteCatalogRefreshOptions {
  /** Cache file to restore from and persist to. Memory-only when absent. */
  cachePath?: string;
  /** When false, restore from cache only (pi's `PI_OFFLINE` convention). */
  allowNetwork?: boolean;
  /** Refetch providers whose entry is older than this. Default: 4h. */
  maxAgeMs?: number;
  signal?: AbortSignal;
}

export class RemoteModelCatalog {
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => number;
  private readonly builtinGeneratedAt?: number;
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly failures = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<CatalogEntry>>();
  private persisting: Promise<void> = Promise.resolve();
  private loadedPath?: string;
  private loading?: Promise<void>;

  constructor(options: RemoteModelCatalogOptions = {}) {
    this.baseUrl = options.baseUrl ?? PI_DEV_CATALOG_BASE_URL;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? Date.now;
    this.builtinGeneratedAt = options.builtinGeneratedAt ?? getBuiltinModelDataGeneratedAt();
  }

  getModels(providerId: string): readonly Model<Api>[] {
    const entry = this.entries.get(providerId);
    if (!entry) {
      return [];
    }
    // Older than what pi-ai baked in: the static catalog is the better source.
    if (this.builtinGeneratedAt !== undefined && entry.lastModified <= this.builtinGeneratedAt) {
      return [];
    }
    return entry.models;
  }

  /**
   * Error text of the most recent failed fetch for a provider, so a resolution
   * failure can say "catalog unavailable" instead of "model does not exist".
   */
  getFailure(providerId: string): string | undefined {
    return this.failures.get(providerId);
  }

  /**
   * Overlay this catalog onto a pi-ai registry. Remote entries win over static
   * ones with the same model id; the overlay is read live, so models fetched by
   * a later `refresh()` become visible without re-attaching.
   */
  attach(models: MutableModels): void {
    for (const provider of models.getProviders()) {
      models.setProvider(this.overlayProvider(provider));
    }
  }

  /**
   * Restore the persisted catalog. Reads each cache file at most once and
   * coalesces concurrent callers onto the in-flight read.
   */
  async load(cachePath: string | undefined): Promise<void> {
    if (cachePath === undefined || this.loadedPath === cachePath) {
      return;
    }
    this.loading ??= this.readCache(cachePath).finally(() => {
      this.loading = undefined;
    });
    await this.loading;
  }

  private async readCache(cachePath: string): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(cachePath, "utf8");
    } catch (error) {
      // Any unreadable cache (absent, wrong type, no permission) degrades to
      // memory-only; it must never fail the resolution waiting on this load.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Model catalog cache '${cachePath}' could not be read: ${error}`);
      }
      this.loadedPath = cachePath;
      return;
    }

    // The cache is derived data: a truncated/corrupt file must not wedge startup.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn(`Model catalog cache '${cachePath}' is unreadable, refetching: ${error}`);
      this.loadedPath = cachePath;
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`Model catalog cache '${cachePath}' is not a provider map, refetching.`);
      this.loadedPath = cachePath;
      return;
    }

    for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== "object") {
        continue;
      }
      const entry = value as Partial<CatalogEntry>;
      let models: readonly Model<Api>[];
      try {
        models = parseModels(providerId, entry.models);
      } catch (error) {
        console.warn(`Cached model catalog for provider '${providerId}' is unusable, refetching: ${error}`);
        continue;
      }
      this.entries.set(providerId, {
        models,
        checkedAt: typeof entry.checkedAt === "number" ? entry.checkedAt : 0,
        lastModified: typeof entry.lastModified === "number" ? entry.lastModified : 0,
      });
    }
    this.loadedPath = cachePath;
  }

  /**
   * Fetch the catalog of every requested provider whose cached entry is stale,
   * then persist. Provider failures are collected, never thrown: a provider we
   * cannot refresh keeps whatever pi-ai baked in.
   */
  async refresh(
    providerIds: readonly string[],
    options: RemoteCatalogRefreshOptions,
  ): Promise<RemoteCatalogRefreshResult> {
    await this.load(options.cachePath);
    const maxAgeMs = options.maxAgeMs ?? REMOTE_CATALOG_REFRESH_INTERVAL_MS;

    if (options.allowNetwork === false) {
      return { fetched: [], models: this.overlaidModelCount(), errors: new Map(), aborted: false };
    }

    const fetched: string[] = [];
    const errors = new Map<string, Error>();
    let changed = false;

    await Promise.all(
      providerIds.map(async (providerId) => {
        if (options.signal?.aborted) {
          return;
        }
        if (this.isFresh(providerId, maxAgeMs)) {
          return;
        }
        try {
          const entry = await this.fetchProviderOnce(providerId, options.signal);
          this.entries.set(providerId, entry);
          this.failures.delete(providerId);
          changed = true;
          if (entry.models.length > 0) {
            fetched.push(providerId);
          }
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          // Remember the attempt so a persistent outage is not re-probed on
          // every resolve, and so callers can tell an outage from a typo.
          this.failures.set(providerId, failure.message);
          const previous = this.entries.get(providerId);
          this.entries.set(providerId, {
            models: previous?.models ?? [],
            checkedAt: this.now(),
            lastModified: previous?.lastModified ?? 0,
          });
          if (options.signal?.aborted) {
            return;
          }
          errors.set(providerId, failure);
        }
      }),
    );

    if (changed && options.cachePath !== undefined) {
      try {
        await this.persist(options.cachePath);
      } catch (error) {
        // The models are already usable in memory; an unwritable cache must not
        // fail the message that is waiting on this refresh.
        console.warn(`Model catalog cache '${options.cachePath}' could not be written: ${error}`);
      }
    }

    return {
      fetched: fetched.sort(),
      models: this.overlaidModelCount(),
      errors,
      aborted: options.signal?.aborted ?? false,
    };
  }

  private overlaidModelCount(): number {
    let models = 0;
    for (const providerId of this.entries.keys()) {
      models += this.getModels(providerId).length;
    }
    return models;
  }

  private isFresh(providerId: string, maxAgeMs: number): boolean {
    const entry = this.entries.get(providerId);
    return entry !== undefined && this.now() - entry.checkedAt < maxAgeMs;
  }

  /** Coalesce concurrent misses for one provider onto a single request. */
  private fetchProviderOnce(providerId: string, signal: AbortSignal | undefined): Promise<CatalogEntry> {
    const existing = this.inflight.get(providerId);
    if (existing) {
      return existing;
    }
    const promise = this.fetchProvider(providerId, signal).finally(() => {
      this.inflight.delete(providerId);
    });
    this.inflight.set(providerId, promise);
    return promise;
  }

  private async fetchProvider(providerId: string, signal: AbortSignal | undefined): Promise<CatalogEntry> {
    const url = new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, this.baseUrl);
    // Resolved per call so a test-time `fetch` stub is honored.
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const response = await doFetch(url, { headers: { accept: "application/json" }, signal });
    const checkedAt = this.now();

    // Providers pi.dev does not publish a catalog for: remember the miss so we
    // do not re-ask on every start.
    if (response.status === 404 || response.status === 501) {
      return { models: [], checkedAt, lastModified: 0 };
    }
    if (!response.ok) {
      throw new Error(`Model catalog request for '${providerId}' failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as unknown;
    const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
    return {
      models: parseModels(providerId, payload),
      checkedAt,
      lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
    };
  }

  /**
   * Serialized against itself: concurrent refreshes each snapshot the whole
   * entry map, so an older snapshot renaming last would drop another
   * provider's freshly fetched catalog.
   */
  private persist(cachePath: string): Promise<void> {
    this.persisting = this.persisting
      .catch(() => {})
      .then(async () => await this.writeCache(cachePath));
    return this.persisting;
  }

  private async writeCache(cachePath: string): Promise<void> {
    const serialized: Record<string, CatalogEntry> = {};
    for (const [providerId, entry] of this.entries) {
      serialized[providerId] = entry;
    }
    await mkdir(dirname(cachePath), { recursive: true });
    // Unique per write: concurrent refreshes in one process must not share a
    // temp file, and rename() keeps readers on a complete file either way.
    const tmpPath = `${cachePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
    await rename(tmpPath, cachePath);
  }

  private overlayProvider(provider: Provider): Provider {
    return {
      ...provider,
      getModels: () => mergeModels(provider.getModels(), this.getModels(provider.id)),
    };
  }
}

function mergeModels(base: readonly Model<Api>[], overlay: readonly Model<Api>[]): readonly Model<Api>[] {
  if (overlay.length === 0) {
    return base;
  }
  const merged = [...base];
  for (const model of overlay) {
    const index = merged.findIndex((entry) => entry.id === model.id);
    if (index >= 0) {
      merged[index] = model;
    } else {
      merged.push(model);
    }
  }
  return merged;
}

/**
 * Accept the shapes pi.dev serves (`{ models: [...] }`, a bare array, or an
 * id-keyed object) and pin every entry to the provider it was fetched for.
 * Throws on an unrecognizable payload so the caller keeps the previous entry
 * instead of persisting an empty catalog.
 */
function parseModels(providerId: string, payload: unknown): readonly Model<Api>[] {
  const entries = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === "object"
      ? Array.isArray((payload as { models?: unknown }).models)
        ? ((payload as { models: unknown[] }).models)
        : Object.values(payload as Record<string, unknown>)
      : undefined;

  if (!entries) {
    throw new Error(`Model catalog for provider '${providerId}' has an unexpected shape.`);
  }

  const models: Model<Api>[] = [];
  const dropped: string[] = [];
  for (const entry of entries) {
    if (!isCompleteModel(entry)) {
      // A partial entry would replace a complete static model with one missing
      // its api/cost, so drop it and keep whatever pi-ai baked in.
      dropped.push(describeEntry(entry));
      continue;
    }
    models.push({ ...entry, provider: providerId });
  }
  if (dropped.length > 0) {
    console.warn(
      `Model catalog for provider '${providerId}': ignoring ${dropped.length} incomplete entries (${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? ", ..." : ""}).`,
    );
  }

  // Entries that all failed validation mean the payload was not a catalog at
  // all (an error body, a schema change): keep the previous entry rather than
  // caching emptiness as a successful check. An explicitly empty catalog
  // (`{ models: [] }`) is still a valid answer and passes through.
  if (entries.length > 0 && models.length === 0) {
    throw new Error(`Model catalog for provider '${providerId}' contained no usable model entries.`);
  }

  return models;
}

/**
 * Every field pi needs at request and accounting time. All four cost rates are
 * mandatory: `calculateCost()` multiplies them unguarded, so a missing rate
 * yields a NaN total, and NaN silently defeats every budget comparison.
 */
function isCompleteModel(value: unknown): value is Model<Api> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const model = value as Partial<Model<Api>>;
  return (
    isNonEmptyString(model.id) &&
    isNonEmptyString(model.name) &&
    isNonEmptyString(model.api) &&
    // Empty is legitimate: Azure deployments take their base URL from config.
    typeof model.baseUrl === "string" &&
    typeof model.reasoning === "boolean" &&
    Array.isArray(model.input) &&
    model.input.every((modality) => modality === "text" || modality === "image") &&
    isPositiveNumber(model.contextWindow) &&
    isPositiveNumber(model.maxTokens) &&
    model.cost !== null &&
    typeof model.cost === "object" &&
    Number.isFinite(model.cost.input) &&
    Number.isFinite(model.cost.output) &&
    Number.isFinite(model.cost.cacheRead) &&
    Number.isFinite(model.cost.cacheWrite)
  );
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function describeEntry(entry: unknown): string {
  const id = (entry as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? id : JSON.stringify(entry)?.slice(0, 60) ?? "<unserializable>";
}
