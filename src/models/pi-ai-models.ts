import { join } from "node:path";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { getMuaddibHome } from "../config/paths.js";
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

const modelCatalog = new RemoteModelCatalog();
modelCatalog.attach(piAiModels);

/**
 * Bring the pi.dev overlay up to date (cache-only while entries are fresh).
 * Best-effort: the timeout and per-provider errors leave the static catalog in
 * place rather than blocking startup.
 */
export async function refreshModelCatalog(
  options: { muaddibHome?: string; timeoutMs?: number } = {},
): Promise<RemoteCatalogRefreshResult> {
  const cachePath = join(options.muaddibHome ?? getMuaddibHome(), "models-store.json");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    return await modelCatalog.refresh(
      piAiModels.getProviders().map((provider) => provider.id),
      { cachePath, signal: controller.signal },
    );
  } finally {
    clearTimeout(timeout);
  }
}
