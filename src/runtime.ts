import { join } from "node:path";

import { assertNoDeferredFeatureConfig } from "./config/deferred-features.js";
import { getMuaddibHome, resolveMuaddibPath } from "./config/paths.js";
import { RuntimeLogWriter } from "./app/logging.js";
import { createChronicleSubsystem, type ChronicleSubsystem } from "./chronicle/create.js";
import { ChatHistoryStore } from "./history/chat-history-store.js";
import { PiAiModelAdapter } from "./models/pi-ai-model-adapter.js";
import { MuaddibConfig } from "./config/muaddib-config.js";

export interface MuaddibRuntime {
  config: MuaddibConfig;
  history: ChatHistoryStore;
  modelAdapter: PiAiModelAdapter;
  getApiKey: (provider: string) => Promise<string | undefined> | string | undefined;
  logger: RuntimeLogWriter;
  chronicle?: ChronicleSubsystem;
}

interface CreateMuaddibRuntimeOptions {
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

  const staticKeys = config.getProviderStaticKeys();
  const getApiKey = (provider: string): string | undefined => staticKeys[provider];
  const modelAdapter = new PiAiModelAdapter({
    deepseekBaseUrl: config.getProvidersConfig().deepseek?.baseUrl,
    getApiKey,
  });

  const historyConfig = config.getHistoryConfig();
  const historyDbPath = options.dbPath ?? resolveMuaddibPath(
    historyConfig.database?.path,
    join(muaddibHome, "chat_history.db"),
  );

  const defaultHistorySize = 40;

  log.info("Initializing history storage", `path=${historyDbPath}`, `history_size=${defaultHistorySize}`);

  const history = new ChatHistoryStore(historyDbPath, defaultHistorySize);
  await history.initialize();

  // Chronicle subsystem
  const chroniclerConfig = config.getChroniclerConfig();
  let chronicle: ChronicleSubsystem | undefined;

  if (chroniclerConfig.model) {
    chronicle = await createChronicleSubsystem({
      model: chroniclerConfig.model,
      arcModels: chroniclerConfig.arcModels,
      paragraphsPerChapter: chroniclerConfig.paragraphsPerChapter,
      databasePath: chroniclerConfig.database?.path,
      muaddibHome,
      history,
      modelAdapter,
      logger: runtimeLogger,
    });
  }

  return {
    config,
    history,
    modelAdapter,
    getApiKey,
    logger: runtimeLogger,
    chronicle,
  };
}

export async function shutdownRuntime(runtime: MuaddibRuntime): Promise<void> {
  await runtime.history.close();
  await runtime.chronicle?.chronicleStore.close();
}
