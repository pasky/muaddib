import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/**
 * Shared pi-ai model registry.
 *
 * pi-ai 0.80 moved its global stream/catalog API (`stream`/`streamSimple`/
 * `completeSimple`, `getModel`/`getProviders`, ...) off the package root and
 * onto a per-instance `Models` object. `builtinModels()` constructs one wired
 * to every built-in provider. A single shared instance keeps provider
 * registration and lazy model catalogs consistent across the app, matching the
 * old global-singleton semantics.
 */
export const piAiModels = builtinModels();
