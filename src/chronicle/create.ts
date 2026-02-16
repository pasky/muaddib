import { join } from "node:path";

import type { RuntimeLogWriter } from "../app/logging.js";
import type { ChatHistoryStore } from "../history/chat-history-store.js";
import type { PiAiModelAdapter } from "../models/pi-ai-model-adapter.js";
import { resolveMuaddibPath } from "../config/paths.js";
import { ChronicleStore } from "./chronicle-store.js";
import { ChronicleLifecycleTs, type ChronicleLifecycleConfig } from "./lifecycle.js";
import { AutoChroniclerTs, type AutoChronicler } from "../rooms/autochronicler.js";

export interface ChronicleSubsystem {
  chronicleStore: ChronicleStore;
  chronicleLifecycle: ChronicleLifecycleTs;
  autoChronicler: AutoChronicler;
}

interface CreateChronicleOptions {
  model: string;
  arcModels?: Record<string, string>;
  paragraphsPerChapter?: number;
  databasePath?: string;
  muaddibHome: string;
  history: ChatHistoryStore;
  modelAdapter: PiAiModelAdapter;
  logger: RuntimeLogWriter;
}

export async function createChronicleSubsystem(
  options: CreateChronicleOptions,
): Promise<ChronicleSubsystem> {
  const chronicleDbPath = resolveMuaddibPath(
    options.databasePath,
    join(options.muaddibHome, "chronicle.db"),
  );

  const log = options.logger.getLogger("muaddib.chronicle");
  log.info("Initializing chronicle storage", `path=${chronicleDbPath}`);

  const chronicleStore = new ChronicleStore(chronicleDbPath);
  await chronicleStore.initialize();

  const lifecycleConfig: ChronicleLifecycleConfig = {
    model: options.model,
    arc_models: options.arcModels,
    paragraphs_per_chapter: options.paragraphsPerChapter,
  };

  const chronicleLifecycle = new ChronicleLifecycleTs({
    chronicleStore,
    config: lifecycleConfig,
    modelAdapter: options.modelAdapter,
    logger: options.logger.getLogger("muaddib.chronicle.lifecycle"),
  });

  const autoChronicler = new AutoChroniclerTs({
    history: options.history,
    chronicleStore,
    lifecycle: chronicleLifecycle,
    config: {
      model: options.model,
      arc_models: options.arcModels,
    },
    modelAdapter: options.modelAdapter,
    logger: options.logger.getLogger("muaddib.rooms.autochronicler"),
  });

  return { chronicleStore, chronicleLifecycle, autoChronicler };
}
