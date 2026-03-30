import { join } from "node:path";

import { AuthStorage } from "@mariozechner/pi-coding-agent";

import { getMuaddibHome } from "./config/paths.js";
import { RuntimeLogWriter } from "./app/logging.js";
import { createChronicleSubsystem, type ChronicleSubsystem } from "./chronicle/create.js";
import { ChatHistoryStore } from "./history/chat-history-store.js";
import { PiAiModelAdapter } from "./models/pi-ai-model-adapter.js";
import { MuaddibConfig } from "./config/muaddib-config.js";

export interface MuaddibRuntime {
  muaddibHome: string;
  config: MuaddibConfig;
  history: ChatHistoryStore;
  modelAdapter: PiAiModelAdapter;
  authStorage: AuthStorage;
  logger: RuntimeLogWriter;
  chronicle?: ChronicleSubsystem;
}

interface CreateMuaddibRuntimeOptions {
  configPath: string;
  muaddibHome?: string;
  arcsPath?: string;
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

  const authStorage = AuthStorage.create(join(muaddibHome, "auth.json"));
  const modelAdapter = new PiAiModelAdapter({ authStorage });

  const arcsPath = options.arcsPath ?? join(muaddibHome, "arcs");

  const defaultHistorySize = 40;

  log.info("Initializing history storage", `path=${arcsPath}`, `history_size=${defaultHistorySize}`);

  const history = new ChatHistoryStore(arcsPath, defaultHistorySize);
  await history.initialize();

  // Chronicle subsystem
  const chroniclerConfig = config.getChroniclerConfig();
  let chronicle: ChronicleSubsystem | undefined;

  if (chroniclerConfig.model) {
    chronicle = await createChronicleSubsystem({
      model: chroniclerConfig.model,
      arcModels: chroniclerConfig.arcModels,
      paragraphsPerChapter: chroniclerConfig.paragraphsPerChapter,
      arcsPath,
      history,
      modelAdapter,
      logger: runtimeLogger,
    });
  }

  return {
    muaddibHome,
    config,
    history,
    modelAdapter,
    authStorage,
    logger: runtimeLogger,
    chronicle,
  };
}

export async function shutdownRuntime(runtime: MuaddibRuntime): Promise<void> {
  await runtime.history.close();
  await runtime.chronicle?.chronicleStore.close();
}
