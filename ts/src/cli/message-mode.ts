import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createConfigApiKeyResolver } from "../app/api-keys.js";
import { assertNoDeferredFeatureConfig } from "../app/deferred-features.js";
import { getMuaddibHome, resolveMuaddibPath } from "../app/bootstrap.js";
import { resolveRefusalFallbackModel } from "../app/refusal-fallback.js";
import { MuaddibAgentRunner } from "../agent/muaddib-agent-runner.js";
import { ChatHistoryStore } from "../history/chat-history-store.js";
import { createModeClassifier } from "../rooms/command/classifier.js";
import { getRoomConfig } from "../rooms/command/config.js";
import {
  RoomCommandHandlerTs,
  type CommandRunnerFactory,
} from "../rooms/command/command-handler.js";
import type { RoomMessage } from "../rooms/message.js";

export interface CliMessageModeOptions {
  message: string;
  configPath: string;
  roomName?: string;
  serverTag?: string;
  channelName?: string;
  nick?: string;
  mynick?: string;
  dbPath?: string;
  runnerFactory?: CommandRunnerFactory;
}

export interface CliMessageModeResult {
  response: string | null;
  mode: string | null;
  trigger: string | null;
  selectedAutomatically: boolean;
}

/**
 * Basic CLI parity path for TS migration:
 * command parse -> context load -> runner call -> response formatting.
 */
export async function runCliMessageMode(options: CliMessageModeOptions): Promise<CliMessageModeResult> {
  const config = JSON.parse(readFileSync(options.configPath, "utf-8")) as Record<string, unknown>;
  assertNoDeferredFeatureConfig(config);

  const roomName = options.roomName ?? "irc";
  const roomConfig = getRoomConfig(config, roomName) as any;
  const commandConfig = roomConfig.command;
  const actorConfig = asRecord(config.actor);
  const toolsConfig = asRecord(config.tools);
  const artifactsConfig = asRecord(toolsConfig?.artifacts);
  const oracleConfig = asRecord(toolsConfig?.oracle);
  const imageGenConfig = asRecord(toolsConfig?.image_gen);
  const providersConfig = asRecord(config.providers);
  const openRouterProviderConfig = asRecord(providersConfig?.openrouter);
  const refusalFallbackModel = resolveRefusalFallbackModel(config);
  const getApiKey = createConfigApiKeyResolver(config);

  const maxIterations = numberOrUndefined(actorConfig?.max_iterations);
  const maxCompletionRetries = numberOrUndefined(actorConfig?.max_completion_retries);
  const jinaApiKey = stringOrUndefined(asRecord(toolsConfig?.jina)?.api_key);
  const artifactsPathRaw = stringOrUndefined(artifactsConfig?.path);
  const artifactsPath = artifactsPathRaw
    ? resolveMuaddibPath(artifactsPathRaw, join(getMuaddibHome(), "artifacts"))
    : undefined;
  const artifactsUrl = stringOrUndefined(artifactsConfig?.url);
  const oracleModel = stringOrUndefined(oracleConfig?.model);
  const oraclePrompt = stringOrUndefined(oracleConfig?.prompt);
  const imageGenModel = stringOrUndefined(imageGenConfig?.model);
  const openRouterBaseUrl = stringOrUndefined(openRouterProviderConfig?.base_url);

  if (!commandConfig) {
    throw new Error(`Room '${roomName}' does not define command config.`);
  }

  const history = new ChatHistoryStore(options.dbPath ?? ":memory:", commandConfig.history_size ?? 40);
  await history.initialize();

  const message: RoomMessage = {
    serverTag: options.serverTag ?? "testserver",
    channelName: options.channelName ?? "#testchannel",
    nick: options.nick ?? "testuser",
    mynick: options.mynick ?? "testbot",
    content: options.message,
  };

  const defaultRunnerFactory: CommandRunnerFactory = (input) =>
    new MuaddibAgentRunner({
      model: input.model,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      getApiKey,
      maxIterations,
      maxCompletionRetries,
    });

  const commandHandler = new RoomCommandHandlerTs({
    roomConfig,
    history,
    classifyMode: createModeClassifier(commandConfig, { getApiKey }),
    getApiKey,
    refusalFallbackModel,
    runnerFactory: options.runnerFactory ?? defaultRunnerFactory,
    agentLoop: {
      maxIterations,
      maxCompletionRetries,
    },
    toolOptions: {
      jinaApiKey,
      artifactsPath,
      artifactsUrl,
      getApiKey,
      oracleModel,
      oraclePrompt,
      imageGenModel,
      openRouterBaseUrl,
    },
  });

  const result = await commandHandler.handleIncomingMessage(message, {
    isDirect: true,
  });
  await history.close();

  return {
    response: result?.response ?? null,
    mode: result?.resolved.modeKey ?? null,
    trigger: result?.resolved.selectedTrigger ?? null,
    selectedAutomatically: result?.resolved.selectedAutomatically ?? false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
