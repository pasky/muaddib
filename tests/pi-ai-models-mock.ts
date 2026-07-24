/**
 * Test double for the shared `src/models/pi-ai-models.js` module.
 *
 * pi-ai 0.80 moved `streamSimple`/`completeSimple`/`getModel`/`getProviders`
 * off the package root onto a per-instance `Models` object, which muaddib
 * exposes as the shared `piAiModels`. Tests mock that shared module instead of
 * the pi-ai package root.
 *
 * This module deliberately imports nothing from `src/` so it can be pulled in
 * from inside a `vi.mock` factory (via dynamic import) without creating an
 * import cycle through the modules being mocked.
 */

import type { AssistantMessage, AssistantMessageEventStream, MutableModels } from "@earendil-works/pi-ai";

export interface PiAiModelsOverrides {
  streamSimple?: (...args: any[]) => AssistantMessageEventStream;
  completeSimple?: (...args: any[]) => Promise<AssistantMessage>;
}

/**
 * Build the mock module object for `src/models/pi-ai-models.js`: a `piAiModels`
 * Proxy over a real `builtinModels()` instance so model catalog reads
 * (`getModel`/`getProviders`) keep working, while `streamSimple` /
 * `completeSimple` are replaced by the supplied scripted test doubles.
 */
export async function buildPiAiModelsMock(overrides: PiAiModelsOverrides): Promise<{
  piAiModels: MutableModels;
  modelCatalog: { getFailure: () => undefined };
  refreshProviderCatalog: () => Promise<void>;
  refreshModelCatalog: () => Promise<{
    fetched: string[];
    models: number;
    errors: Map<string, Error>;
    aborted: boolean;
  }>;
}> {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const real = builtinModels();
  const piAiModels = new Proxy(real, {
    get(target, prop) {
      if (prop === "streamSimple" && overrides.streamSimple) return overrides.streamSimple;
      if (prop === "completeSimple" && overrides.completeSimple) return overrides.completeSimple;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // Tests never touch the pi.dev catalog; the static registry is enough, so the
  // on-miss refresh is a no-op and resolution misses stay misses.
  const refreshModelCatalog = async () => ({
    fetched: [],
    models: 0,
    errors: new Map<string, Error>(),
    aborted: false,
  });
  const refreshProviderCatalog = async () => {};
  const modelCatalog = { getFailure: () => undefined };
  return { piAiModels, modelCatalog, refreshProviderCatalog, refreshModelCatalog };
}
