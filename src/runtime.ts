import { join } from "node:path";

import { assertNoDeferredFeatureConfig } from "./config/deferred-features.js";
import { getMuaddibHome, resolveMuaddibPath } from "./config/paths.js";
import { RuntimeLogWriter, type RuntimeLogger } from "./app/logging.js";
import { ChronicleStore } from "./chronicle/chronicle-store.js";
import {
  ChronicleLifecycleTs,
  type ChronicleLifecycleConfig,
} from "./chronicle/lifecycle.js";
import { ChatHistoryStore } from "./history/chat-history-store.js";
import {
  createPiAiModelAdapterFromConfig,
  type PiAiModelAdapter,
} from "./models/pi-ai-model-adapter.js";
import { parseModelSpec } from "./models/model-spec.js";
import { AutoChroniclerTs, type AutoChronicler } from "./rooms/autochronicler.js";
import { MuaddibConfig } from "./config/muaddib-config.js";

export interface MuaddibRuntime {
  config: MuaddibConfig;
  history: ChatHistoryStore;
  modelAdapter: PiAiModelAdapter;
  getApiKey: (provider: string) => Promise<string | undefined> | string | undefined;
  logger: RuntimeLogWriter;
  refusalFallbackModel?: string;
  persistenceSummaryModel?: string;
  chronicleStore?: ChronicleStore;
  chronicleLifecycle?: ChronicleLifecycleTs;
  autoChronicler?: AutoChronicler;
}

export interface CreateMuaddibRuntimeOptions {
  configPath: string;
  muaddibHome?: string;
  dbPath?: string;
  /** Override logger (for tests). */
  logger?: RuntimeLogWriter;
}

export async function createMuaddibRuntime(
  options: CreateMuaddibRuntimeOptions,
): Promise<MuaddibRuntime> {
  const muaddibHome = options.muaddibHome ?? getMuaddibHome();
  const runtimeLogger = options.logger ?? new RuntimeLogWriter({ muaddibHome });
  const log = runtimeLogger.getLogger("muaddib.runtime");

  const config = MuaddibConfig.load(options.configPath);
  assertNoDeferredFeatureConfig(config, log);

  const modelAdapter = createPiAiModelAdapterFromConfig(config);
  const staticKeys = config.getProviderStaticKeys();
  const getApiKey = (provider: string): string | undefined => staticKeys[provider];

  const refusalFallbackModel = resolveRefusalFallbackModel(config, modelAdapter);
  const persistenceSummaryModel = resolvePersistenceSummaryModel(config, modelAdapter);

  const historyConfig = config.getHistoryConfig();
  const historyDbPath = options.dbPath ?? resolveMuaddibPath(
    historyConfig.database?.path,
    join(muaddibHome, "chat_history.db"),
  );

  const defaultRoomConfig = config.getRoomConfig("irc");
  const defaultHistorySize = Number(defaultRoomConfig.command?.history_size ?? 40);

  log.info("Initializing history storage", `path=${historyDbPath}`, `history_size=${defaultHistorySize}`);

  const history = new ChatHistoryStore(historyDbPath, defaultHistorySize);
  await history.initialize();

  // Chronicle subsystem
  const chroniclerConfig = config.getChroniclerConfig();
  let chronicleStore: ChronicleStore | undefined;
  let chronicleLifecycle: ChronicleLifecycleTs | undefined;
  let autoChronicler: AutoChronicler | undefined;

  if (chroniclerConfig.model) {
    const chronicleDbPath = resolveMuaddibPath(
      chroniclerConfig.database?.path,
      join(muaddibHome, "chronicle.db"),
    );

    log.info("Initializing chronicle storage", `path=${chronicleDbPath}`);

    chronicleStore = new ChronicleStore(chronicleDbPath);
    await chronicleStore.initialize();

    const lifecycleConfig: ChronicleLifecycleConfig = {
      model: chroniclerConfig.model,
      arc_models: chroniclerConfig.arcModels,
      paragraphs_per_chapter: chroniclerConfig.paragraphsPerChapter,
    };

    chronicleLifecycle = new ChronicleLifecycleTs({
      chronicleStore,
      config: lifecycleConfig,
      modelAdapter,
      getApiKey,
      logger: runtimeLogger.getLogger("muaddib.chronicle.lifecycle"),
    });

    autoChronicler = new AutoChroniclerTs({
      history,
      chronicleStore,
      lifecycle: chronicleLifecycle,
      config: {
        model: chroniclerConfig.model,
        arc_models: chroniclerConfig.arcModels,
      },
      modelAdapter,
      getApiKey,
      logger: runtimeLogger.getLogger("muaddib.rooms.autochronicler"),
    });
  }

  return {
    config,
    history,
    modelAdapter,
    getApiKey,
    logger: runtimeLogger,
    refusalFallbackModel,
    persistenceSummaryModel,
    chronicleStore,
    chronicleLifecycle,
    autoChronicler,
  };
}

export async function shutdownRuntime(runtime: MuaddibRuntime): Promise<void> {
  await runtime.history.close();
  await runtime.chronicleStore?.close();
}

// ── Model resolution helpers (inlined from former app/ modules) ────────

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function resolveRefusalFallbackModel(
  config: MuaddibConfig,
  modelAdapter: PiAiModelAdapter,
): string | undefined {
  const rawFallbackModel = config.getRouterConfig().refusalFallbackModel;

  if (rawFallbackModel === undefined) {
    return undefined;
  }

  if (rawFallbackModel.trim().length === 0) {
    throw new Error(
      "router.refusal_fallback_model must be a non-empty string fully qualified as provider:model.",
    );
  }

  const trimmedModel = rawFallbackModel.trim();

  let normalizedModel: string;
  try {
    const spec = parseModelSpec(trimmedModel);
    normalizedModel = `${spec.provider}:${spec.modelId}`;
  } catch (error) {
    throw new Error(
      `Invalid router.refusal_fallback_model '${trimmedModel}': ${stringifyError(error)}`,
    );
  }

  try {
    modelAdapter.resolve(normalizedModel);
  } catch (error) {
    throw new Error(
      `Unsupported router.refusal_fallback_model '${normalizedModel}': ${stringifyError(error)}`,
    );
  }

  return normalizedModel;
}

function resolvePersistenceSummaryModel(
  config: MuaddibConfig,
  modelAdapter: PiAiModelAdapter,
): string | undefined {
  const rawSummaryModel = config.getToolsConfig().summary?.model;

  if (rawSummaryModel === undefined || rawSummaryModel === null) {
    return undefined;
  }

  if (typeof rawSummaryModel !== "string" || rawSummaryModel.trim().length === 0) {
    throw new Error(
      "tools.summary.model must be a non-empty string fully qualified as provider:model.",
    );
  }

  const trimmedModel = rawSummaryModel.trim();

  let normalizedModel: string;
  try {
    const spec = parseModelSpec(trimmedModel);
    normalizedModel = `${spec.provider}:${spec.modelId}`;
  } catch (error) {
    throw new Error(`Invalid tools.summary.model '${trimmedModel}': ${stringifyError(error)}`);
  }

  try {
    modelAdapter.resolve(normalizedModel);
  } catch (error) {
    throw new Error(
      `Unsupported tools.summary.model '${normalizedModel}': ${stringifyError(error)}`,
    );
  }

  return normalizedModel;
}
