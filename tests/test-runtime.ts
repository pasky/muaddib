import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage } from "@mariozechner/pi-coding-agent";

import { RuntimeLogWriter } from "../src/app/logging.js";
import { MuaddibConfig } from "../src/config/muaddib-config.js";
import type { ChatHistoryStore } from "../src/history/chat-history-store.js";
import { PiAiModelAdapter } from "../src/models/pi-ai-model-adapter.js";
import type { MuaddibRuntime } from "../src/runtime.js";

interface CreateTestRuntimeOptions {
  history: ChatHistoryStore;
  configData?: Record<string, unknown>;
  authStorage: AuthStorage;
  logger?: RuntimeLogWriter;
  muaddibHome?: string;
}

export function createTestRuntime(options: CreateTestRuntimeOptions): MuaddibRuntime {
  const muaddibHome = options.muaddibHome ?? join(tmpdir(), "muaddib-test-runtime");

  return {
    muaddibHome,
    config: MuaddibConfig.inMemory(options.configData ?? {}),
    history: options.history,
    modelAdapter: new PiAiModelAdapter(),
    authStorage: options.authStorage,
    logger: options.logger ?? new RuntimeLogWriter({
      muaddibHome,
      stdout: {
        write: () => true,
      } as unknown as NodeJS.WriteStream,
    }),
  };
}
