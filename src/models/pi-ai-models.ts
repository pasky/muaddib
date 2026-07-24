import { join } from "node:path";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { RemoteModelCatalog, type RemoteCatalogRefreshResult } from "./remote-catalog.js";

/**
 * Shared pi-ai model registry.
 *
 * pi-ai 0.80 moved its global stream/catalog API (`stream`/`streamSimple`/
 * `completeSimple`, `getModel`/`getProviders`, ...) off the package root and
 * onto a per-instance `Models` object. `builtinModels()` constructs one wired
 * to every built-in provider. A single shared instance keeps provider
 * registration and lazy model catalogs consistent across the app, matching the
 * old global-singleton semantics.
 *
 * pi-ai's built-in catalog is static (baked at package build time), so it is
 * overlaid with the live pi.dev catalog — otherwise models released after the
 * pinned pi-ai version would be unresolvable until a dependency bump.
 */
export const piAiModels = builtinModels();

export const modelCatalog = new RemoteModelCatalog();
modelCatalog.attach(piAiModels);

/** On-miss refetch throttle: an unknown model must not re-probe pi.dev per resolve. */
const MISS_REFETCH_INTERVAL_MS = 60_000;

/** A user is waiting on the message that triggered an on-miss refresh. */
const MISS_REFRESH_TIMEOUT_MS = 5_000;

const STARTUP_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Cache file the runtime configured. Until then the catalog stays memory-only,
 * so importing this module never touches (or creates) a muaddib home.
 */
let cachePath: string | undefined;

async function refresh(
  providerIds: readonly string[],
  maxAgeMs: number | undefined,
  timeoutMs: number,
): Promise<RemoteCatalogRefreshResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await modelCatalog.refresh(providerIds, { cachePath, maxAgeMs, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Bring the pi.dev overlay up to date for every provider and start persisting
 * to `<muaddibHome>/models-store.json`. Best-effort: the timeout and
 * per-provider errors leave the static catalog in place rather than blocking
 * startup.
 */
export async function refreshModelCatalog(muaddibHome: string): Promise<RemoteCatalogRefreshResult> {
  cachePath = join(muaddibHome, "models-store.json");
  return await refresh(
    piAiModels.getProviders().map((provider) => provider.id),
    undefined,
    STARTUP_REFRESH_TIMEOUT_MS,
  );
}

/**
 * Refetch one provider's catalog after a model id missed both the static
 * registry and the overlay — the `@provider:model` override lets a user name a
 * model that was released after this process started.
 */
export async function refreshProviderCatalog(providerId: string): Promise<void> {
  await refresh([providerId], MISS_REFETCH_INTERVAL_MS, MISS_REFRESH_TIMEOUT_MS);
}
