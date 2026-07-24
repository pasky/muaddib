import { join } from "node:path";

import { AuthStore } from "./auth/auth-store.js";

import { getMuaddibHome } from "./config/paths.js";
import { RuntimeLogWriter } from "./app/logging.js";
import { createChronicleSubsystem, type ChronicleSubsystem } from "./chronicle/create.js";
import { ChatHistoryStore } from "./history/chat-history-store.js";
import { PiAiModelAdapter } from "./models/pi-ai-model-adapter.js";
import { refreshModelCatalog } from "./models/pi-ai-models.js";
import { MuaddibConfig } from "./config/muaddib-config.js";
import type { NetworkAccessApprover } from "./agent/network-boundary.js";

export interface MuaddibRuntime {
  muaddibHome: string;
  config: MuaddibConfig;
  history: ChatHistoryStore;
  modelAdapter: PiAiModelAdapter;
  authStorage: AuthStore;
  logger: RuntimeLogWriter;
  chronicle?: ChronicleSubsystem;
  networkAccessApprover?: NetworkAccessApprover;
}

interface CreateMuaddibRuntimeOptions {
  configPath: string;
  muaddibHome?: string;
  arcsPath?: string;
  /** Override logger (for tests). */
  logger?: RuntimeLogWriter;
  networkAccessApprover?: NetworkAccessApprover;
}

export async function createMuaddibRuntime(
  options: CreateMuaddibRuntimeOptions,
): Promise<MuaddibRuntime> {
  const muaddibHome = options.muaddibHome ?? getMuaddibHome();
  const runtimeLogger = options.logger ?? new RuntimeLogWriter({ muaddibHome });
  const log = runtimeLogger.getLogger("muaddib.runtime");

  const config = MuaddibConfig.load(options.configPath);

  const authStorage = AuthStore.create(join(muaddibHome, "auth.json"));
  const modelAdapter = new PiAiModelAdapter({ authStorage });

  // Overlay the live pi.dev catalog so models newer than the pinned pi-ai
  // release resolve. Best-effort: a failure just leaves the static catalog.
  try {
    const catalog = await refreshModelCatalog(muaddibHome);
    log.info(
      "Model catalog refreshed",
      `fetched=${catalog.fetched.length}`,
      `models=${catalog.models}`,
      `errors=${catalog.errors.size}`,
      `aborted=${catalog.aborted}`,
    );
    for (const [providerId, error] of catalog.errors) {
      log.debug("Model catalog refresh failed", `provider=${providerId}`, String(error));
    }
  } catch (error) {
    log.error("Model catalog refresh failed", String(error));
  }

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
    networkAccessApprover: options.networkAccessApprover,
  };
}

export async function shutdownRuntime(runtime: MuaddibRuntime): Promise<void> {
  await runtime.history.close();
  await runtime.chronicle?.chronicleStore.close();
}
