import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeLogWriter } from "../src/app/logging.js";
import { MuaddibConfig } from "../src/config/muaddib-config.js";
import type { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { PiAiModelAdapter } from "../src/models/pi-ai-model-adapter.js";
import type { MuaddibRuntime } from "../src/runtime.js";

interface CreateTestRuntimeOptions {
  history: ChatHistoryStore;
  configData?: Record<string, unknown>;
  refusalFallbackModel?: string;
  persistenceSummaryModel?: string;
  logger?: RuntimeLogWriter;
}

export function createTestRuntime(options: CreateTestRuntimeOptions): MuaddibRuntime {
  return {
    config: MuaddibConfig.inMemory(options.configData ?? {}),
    history: options.history,
    modelAdapter: new PiAiModelAdapter(),
    getApiKey: () => undefined,
    logger: options.logger ?? new RuntimeLogWriter({
      muaddibHome: join(tmpdir(), "muaddib-test-runtime"),
      stdout: {
        write: () => true,
      } as unknown as NodeJS.WriteStream,
    }),
    refusalFallbackModel: options.refusalFallbackModel,
    persistenceSummaryModel: options.persistenceSummaryModel,
  };
}
