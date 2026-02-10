import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Usage } from "@mariozechner/pi-ai";

import {
  MuaddibAgentRunner,
  type MuaddibAgentRunnerOptions,
  type RunnerContextMessage,
  type SingleTurnResult,
} from "../../agent/muaddib-agent-runner.js";
import { createBaselineAgentTools } from "../../agent/tools/baseline-tools.js";
import type { ChatHistoryStore } from "../../history/chat-history-store.js";
import type { RoomMessage } from "../message.js";
import {
  CommandResolver,
  type CommandConfig,
  type ResolvedCommand,
} from "./resolver.js";

export interface CommandHandlerRoomConfig {
  command: CommandConfig;
  prompt_vars?: Record<string, string>;
}

export interface CommandRunner {
  runSingleTurn(prompt: string, options?: { contextMessages?: RunnerContextMessage[] }): Promise<SingleTurnResult>;
}

export interface CommandRunnerFactoryInput {
  model: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
}

export type CommandRunnerFactory = (input: CommandRunnerFactoryInput) => CommandRunner;

export interface CommandHandlerOptions {
  roomConfig: CommandHandlerRoomConfig;
  history: ChatHistoryStore;
  classifyMode: (context: Array<{ role: string; content: string }>) => Promise<string>;
  runnerFactory?: CommandRunnerFactory;
  responseCleaner?: (text: string, nick: string) => string;
  helpToken?: string;
  flagTokens?: string[];
  onProgressReport?: (text: string) => void | Promise<void>;
}

export interface CommandExecutionResult {
  response: string | null;
  resolved: ResolvedCommand;
  model: string | null;
  usage: Usage | null;
}

export interface HandleIncomingMessageOptions {
  isDirect: boolean;
  sendResponse?: (text: string) => Promise<void>;
}

/**
 * Shared TS command execution path (without proactive handling).
 */
export class RoomCommandHandlerTs {
  readonly resolver: CommandResolver;
  private readonly commandConfig: CommandConfig;
  private readonly runnerFactory: CommandRunnerFactory;

  constructor(private readonly options: CommandHandlerOptions) {
    this.commandConfig = options.roomConfig.command;

    this.resolver = new CommandResolver(
      this.commandConfig,
      options.classifyMode,
      options.helpToken ?? "!h",
      new Set(options.flagTokens ?? ["!c"]),
      modelStrCore,
    );

    this.runnerFactory =
      options.runnerFactory ??
      ((input) =>
        new MuaddibAgentRunner({
          model: input.model,
          systemPrompt: input.systemPrompt,
          tools: input.tools,
        } as MuaddibAgentRunnerOptions));
  }

  shouldIgnoreUser(nick: string): boolean {
    const ignoreUsers = this.commandConfig.ignore_users ?? [];
    return ignoreUsers.some((ignored) => String(ignored).toLowerCase() === nick.toLowerCase());
  }

  async handleIncomingMessage(
    message: RoomMessage,
    options: HandleIncomingMessageOptions,
  ): Promise<CommandExecutionResult | null> {
    await this.options.history.addMessage(message);

    if (!options.isDirect) {
      return null;
    }

    const result = await this.execute(message);
    if (!result.response) {
      return result;
    }

    if (options.sendResponse) {
      await options.sendResponse(result.response);
    }

    await this.options.history.addMessage(
      {
        ...message,
        nick: message.mynick,
        content: result.response,
      },
      {
        mode: result.resolved.selectedTrigger ?? undefined,
      },
    );

    return result;
  }

  async execute(message: RoomMessage): Promise<CommandExecutionResult> {
    const defaultSize = this.commandConfig.history_size;
    const maxSize = Math.max(
      defaultSize,
      ...Object.values(this.commandConfig.modes).map((mode) => Number(mode.history_size ?? 0)),
    );

    const context = await this.options.history.getContextForMessage(message, maxSize);

    const resolved = await this.resolver.resolve({
      message,
      context,
      defaultSize,
    });

    if (resolved.error) {
      return {
        response: `${message.nick}: ${resolved.error}`,
        resolved,
        model: null,
        usage: null,
      };
    }

    if (resolved.helpRequested) {
      return {
        response: this.resolver.buildHelpMessage(message.serverTag, message.channelName),
        resolved,
        model: null,
        usage: null,
      };
    }

    if (!resolved.modeKey || !resolved.runtime || !resolved.selectedTrigger) {
      return {
        response: `${message.nick}: Internal command resolution error.`,
        resolved,
        model: null,
        usage: null,
      };
    }

    const modeConfig = this.commandConfig.modes[resolved.modeKey];
    const modelSpec =
      resolved.modelOverride ?? resolved.runtime.model ?? pickModeModel(modeConfig.model) ?? null;

    if (!modelSpec) {
      return {
        response: `${message.nick}: No model configured for mode '${resolved.modeKey}'.`,
        resolved,
        model: null,
        usage: null,
      };
    }

    const runnerContext = (resolved.noContext ? context.slice(-1) : context)
      .slice(-resolved.runtime.historySize)
      .map(toRunnerContextMessage);

    const systemPrompt = this.buildSystemPrompt(
      resolved.modeKey,
      message.mynick,
      resolved.modelOverride ?? undefined,
    );

    const tools = this.selectTools(resolved.runtime.allowedTools);
    const runner = this.runnerFactory({
      model: modelSpec,
      systemPrompt,
      tools,
    });

    const agentResult = await runner.runSingleTurn(resolved.queryText, {
      contextMessages: runnerContext,
    });

    const cleaned = this.cleanResponseText(agentResult.text, message.nick);

    return {
      response: cleaned || null,
      resolved,
      model: modelSpec,
      usage: agentResult.usage,
    };
  }

  buildSystemPrompt(mode: string, mynick: string, modelOverride?: string): string {
    const modeConfig = this.commandConfig.modes[mode];
    if (!modeConfig) {
      throw new Error(`Command mode '${mode}' not found in config`);
    }

    let promptTemplate = modeConfig.prompt ?? "You are {mynick}. Current time: {current_time}.";

    const triggerModelVars: Record<string, string> = {};
    for (const [trigger, modeKey] of Object.entries(this.resolver.triggerToMode)) {
      const triggerOverrideModel = this.resolver.triggerOverrides[trigger]?.model as string | undefined;
      const effectiveModel =
        triggerOverrideModel ??
        (modeKey === mode && modelOverride ? modelOverride : pickModeModel(this.commandConfig.modes[modeKey].model));
      triggerModelVars[`${trigger}_model`] = modelStrCore(effectiveModel ?? "");
    }

    promptTemplate = promptTemplate.replace(
      /\{(![A-Za-z][\w-]*_model)\}/g,
      (_full, key: string) => triggerModelVars[key] ?? _full,
    );

    const promptVars = this.options.roomConfig.prompt_vars ?? {};
    const vars: Record<string, string> = {
      ...promptVars,
      mynick,
      current_time: formatCurrentTime(),
    };

    return promptTemplate.replace(/\{([A-Za-z0-9_]+)\}/g, (full, key: string) => vars[key] ?? full);
  }

  private cleanResponseText(text: string, nick: string): string {
    const cleaned = text.trim();
    if (!this.options.responseCleaner) {
      return cleaned;
    }
    return this.options.responseCleaner(cleaned, nick).trim();
  }

  private selectTools(allowedTools: string[] | null): AgentTool<any>[] {
    const baseline = createBaselineAgentTools({
      onProgressReport: this.options.onProgressReport,
    });

    if (!allowedTools) {
      return baseline;
    }

    const allowed = new Set(allowedTools);
    return baseline.filter((tool) => allowed.has(tool.name));
  }
}

function modelStrCore(model: unknown): string {
  return String(model).replace(/(?:[-\w]*:)?(?:[-\w]*\/)?([-\w]+)(?:#[-\w,]*)?/, "$1");
}

function pickModeModel(model: string | string[] | undefined): string | null {
  if (!model) {
    return null;
  }
  if (Array.isArray(model)) {
    return model[0] ?? null;
  }
  return model;
}

function toRunnerContextMessage(message: { role: string; content: string }): RunnerContextMessage {
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
  };
}

function formatCurrentTime(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
