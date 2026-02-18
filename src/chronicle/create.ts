import { join } from "node:path";

import type { AuthStorage } from "@mariozechner/pi-coding-agent";

import type { RuntimeLogWriter } from "../app/logging.js";
import type { ChatHistoryStore } from "../history/chat-history-store.js";
import type { PiAiModelAdapter } from "../models/pi-ai-model-adapter.js";
import { resolveMuaddibPath } from "../config/paths.js";
import { ChronicleStore } from "./chronicle-store.js";
import { ChronicleLifecycleTs, type ChronicleLifecycleConfig } from "./lifecycle.js";
import { QuestRuntimeTs, type QuestStepRunner } from "./quest-runtime.js";
import { AutoChroniclerTs, type AutoChronicler } from "../rooms/autochronicler.js";
import { SessionRunner } from "../agent/session-runner.js";
import { createBaselineAgentTools } from "../agent/tools/baseline-tools.js";

export interface ChronicleSubsystem {
  chronicleStore: ChronicleStore;
  chronicleLifecycle: ChronicleLifecycleTs;
  autoChronicler: AutoChronicler;
  questRuntime?: QuestRuntimeTs;
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
  quests?: {
    arcs?: string[];
    promptReminder?: string;
    cooldown?: number;
  };
  authStorage: AuthStorage;
  actorConfig?: { maxIterations?: number; llmDebugMaxChars?: number; progress?: { thresholdSeconds?: number; minIntervalSeconds?: number } };
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

  // Quest runtime (optional)
  const questsConfig = options.quests;
  let questRuntime: QuestRuntimeTs | undefined;

  if (questsConfig?.arcs && questsConfig.arcs.length > 0) {
    questRuntime = new QuestRuntimeTs({
      chronicleStore,
      appendParagraph: async (arc, text) => {
        // Will be set after chronicleLifecycle is created (circular ref)
        return chronicleLifecycle.appendParagraph(arc, text);
      },
      config: {
        arcs: questsConfig.arcs,
        cooldownSeconds: questsConfig.cooldown ?? 30,
      },
      runQuestStep: createQuestStepRunner({
        model: options.model,
        modelAdapter: options.modelAdapter,
        authStorage: options.authStorage,
        promptReminder: questsConfig.promptReminder,
        actorConfig: options.actorConfig,
        logger: options.logger,
      }),
      logger: options.logger.getLogger("muaddib.chronicle.quests"),
    });
  }

  const chronicleLifecycle = new ChronicleLifecycleTs({
    chronicleStore,
    config: lifecycleConfig,
    modelAdapter: options.modelAdapter,
    questRuntime,
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

  return { chronicleStore, chronicleLifecycle, autoChronicler, questRuntime };
}

// ── Quest step runner factory ──

interface QuestStepRunnerOptions {
  model: string;
  modelAdapter: PiAiModelAdapter;
  authStorage: AuthStorage;
  promptReminder?: string;
  actorConfig?: { maxIterations?: number; llmDebugMaxChars?: number; progress?: { thresholdSeconds?: number; minIntervalSeconds?: number } };
  logger: RuntimeLogWriter;
}

function createQuestStepRunner(options: QuestStepRunnerOptions): QuestStepRunner {
  const { model, modelAdapter, authStorage, actorConfig, logger: runtimeLogger } = options;

  return async (input) => {
    const log = runtimeLogger.getLogger(`muaddib.chronicle.quests.step.${input.questId}`);

    // Build quest-specific metaReminder by replacing <quest> placeholder with quest ID
    const baseReminder = options.promptReminder ?? "";
    const metaReminder = baseReminder.replace(/<quest>/g, `<quest> ${input.questId}`);

    // Minimal system prompt for quest steps
    const systemPrompt = `You are an AI agent executing a quest step. Current time: ${new Date().toISOString()}.`;

    // Build tools with quest context (currentQuestId enables correct quest tool selection)
    const tools = createBaselineAgentTools({
      modelAdapter,
      authStorage,
      currentQuestId: input.questId,
      logger: log,
    });

    const runner = new SessionRunner({
      model,
      systemPrompt,
      tools,
      modelAdapter,
      authStorage,
      maxIterations: actorConfig?.maxIterations,
      llmDebugMaxChars: actorConfig?.llmDebugMaxChars,
      metaReminder: metaReminder || undefined,
      progressThresholdSeconds: actorConfig?.progress?.thresholdSeconds,
      progressMinIntervalSeconds: actorConfig?.progress?.minIntervalSeconds,
      logger: log,
    });

    const prompt = input.lastState
      ? `${input.lastState}\n\nContinue this quest step for quest "${input.questId}" in arc "${input.arc}".`
      : `Begin quest step for quest "${input.questId}" in arc "${input.arc}".`;

    try {
      const result = await runner.prompt(prompt);
      result.session?.dispose();

      let text = result.text?.trim();
      if (!text || text.startsWith("Error: ")) {
        log.warn("Quest step produced no usable output", `text=${text ?? "(empty)"}`);
        return { paragraphText: `${input.lastState}. Previous quest call failed (${text ?? "empty"}).` };
      }

      // Normalize quest tags: ensure CONFIRMED ACHIEVED → quest_finished
      const isFinished = /\bCONFIRMED\s+ACHIEVED\b/i.test(text);
      if (isFinished && !text.includes("<quest_finished")) {
        if (/<\s*quest\b/i.test(text)) {
          text = text.replace(/<\s*quest\b/i, "<quest_finished");
          text = text.replace(/<\/\s*quest\s*>/i, "</quest_finished>");
        } else {
          text = `<quest_finished>${text}</quest_finished>`;
        }
      }

      // Ensure quest tags exist with correct id
      if (!text.includes("<quest")) {
        text = `<quest>${text}</quest>`;
      }
      text = text.replace(
        /<quest(_finished)?(\s*id="[^"]*")?\s*>/g,
        (_match, suffix) => `<quest${suffix ?? ""} id="${input.questId}">`,
      );

      return { paragraphText: text };
    } catch (error) {
      log.error("Quest step failed", error);
      return { paragraphText: `${input.lastState}. Previous quest call failed (${error}).` };
    }
  };
}
