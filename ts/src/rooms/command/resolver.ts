import type { RoomMessage } from "../message.js";

export interface ParsedPrefix {
  noContext: boolean;
  modeToken: string | null;
  modelOverride: string | null;
  queryText: string;
  error: string | null;
}

export interface ResolvedCommand {
  noContext: boolean;
  queryText: string;
  modelOverride: string | null;
  selectedLabel: string | null;
  selectedTrigger: string | null;
  modeKey: string | null;
  runtime: RuntimeSettings | null;
  error?: string;
  helpRequested: boolean;
  channelMode?: string;
  selectedAutomatically: boolean;
}

export interface RuntimeSettings {
  reasoningEffort: string;
  allowedTools: string[] | null;
  steering: boolean;
  model: string | null;
  historySize: number;
}

export interface ModeConfig {
  model?: string | string[];
  history_size?: number;
  reasoning_effort?: string;
  allowed_tools?: string[];
  steering?: boolean;
  prompt?: string;
  triggers: Record<string, Record<string, unknown>>;
}

export interface ModeClassifierConfig {
  labels: Record<string, string>;
  fallback_label?: string;
  model: string;
  prompt?: string;
}

export interface CommandConfig {
  history_size: number;
  response_max_bytes?: number;
  debounce?: number;
  rate_limit?: number;
  rate_period?: number;
  default_mode?: string;
  channel_modes?: Record<string, string>;
  ignore_users?: string[];
  modes: Record<string, ModeConfig>;
  mode_classifier: ModeClassifierConfig;
}

export class CommandResolver {
  readonly triggerToMode: Record<string, string> = {};
  readonly triggerOverrides: Record<string, Record<string, unknown>> = {};
  readonly defaultTriggerByMode: Record<string, string> = {};
  readonly classifierLabelToTrigger: Record<string, string>;
  readonly fallbackClassifierLabel: string;

  constructor(
    private readonly commandConfig: CommandConfig,
    private readonly classifyModeFn: (context: Array<{ role: string; content: string }>) => Promise<string>,
    private readonly helpToken: string,
    private readonly flagTokens: Set<string>,
    private readonly modelNameFormatter: (value: unknown) => string,
  ) {
    for (const [modeKey, modeConfig] of Object.entries(commandConfig.modes)) {
      const triggers = modeConfig.triggers;
      const triggerKeys = Object.keys(triggers);
      if (triggerKeys.length === 0) {
        throw new Error(`Mode '${modeKey}' must define at least one trigger`);
      }

      this.defaultTriggerByMode[modeKey] = triggerKeys[0];

      for (const trigger of triggerKeys) {
        if (this.triggerToMode[trigger]) {
          throw new Error(`Duplicate trigger '${trigger}' in command mode config`);
        }
        if (!trigger.startsWith("!")) {
          throw new Error(`Invalid trigger '${trigger}' for mode '${modeKey}'`);
        }

        this.triggerToMode[trigger] = modeKey;
        this.triggerOverrides[trigger] = triggers[trigger] ?? {};
      }
    }

    this.classifierLabelToTrigger = commandConfig.mode_classifier.labels;
    if (Object.keys(this.classifierLabelToTrigger).length === 0) {
      throw new Error("command.mode_classifier.labels must not be empty");
    }

    for (const [label, trigger] of Object.entries(this.classifierLabelToTrigger)) {
      if (!this.triggerToMode[trigger]) {
        throw new Error(`Classifier label '${label}' points to unknown trigger '${trigger}'`);
      }
    }

    this.fallbackClassifierLabel =
      commandConfig.mode_classifier.fallback_label ?? Object.keys(this.classifierLabelToTrigger)[0];

    if (!this.classifierLabelToTrigger[this.fallbackClassifierLabel]) {
      throw new Error(
        `Classifier fallback label '${this.fallbackClassifierLabel}' is not defined in labels`,
      );
    }
  }

  parsePrefix(message: string): ParsedPrefix {
    const text = message.trim();
    if (!text) {
      return {
        noContext: false,
        modeToken: null,
        modelOverride: null,
        queryText: "",
        error: null,
      };
    }

    const tokens = text.split(/\s+/);
    let noContext = false;
    let modeToken: string | null = null;
    let modelOverride: string | null = null;
    let error: string | null = null;
    let consumed = 0;

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];

      if (this.flagTokens.has(token)) {
        noContext = true;
        consumed = i + 1;
        continue;
      }

      if (this.triggerToMode[token] || token === this.helpToken) {
        if (modeToken !== null) {
          error = "Only one mode command allowed.";
          break;
        }
        modeToken = token;
        consumed = i + 1;
        continue;
      }

      if (token.startsWith("@") && token.length > 1) {
        if (modelOverride === null) {
          modelOverride = token.slice(1);
        }
        consumed = i + 1;
        continue;
      }

      if (token.startsWith("!")) {
        error = `Unknown command '${token}'. Use ${this.helpToken} for help.`;
        break;
      }

      break;
    }

    const queryText = consumed > 0 ? tokens.slice(consumed).join(" ") : text;
    return { noContext, modeToken, modelOverride, queryText, error };
  }

  runtimeForTrigger(trigger: string): [string, RuntimeSettings] {
    const modeKey = this.triggerToMode[trigger];
    if (!modeKey) {
      throw new Error(`Unknown trigger '${trigger}'`);
    }

    const modeConfig = this.commandConfig.modes[modeKey];
    const overrides = this.triggerOverrides[trigger] ?? {};

    return [
      modeKey,
      {
        reasoningEffort:
          (overrides.reasoning_effort as string | undefined) ?? modeConfig.reasoning_effort ?? "minimal",
        allowedTools:
          (overrides.allowed_tools as string[] | undefined) ?? modeConfig.allowed_tools ?? null,
        steering: (overrides.steering as boolean | undefined) ?? modeConfig.steering ?? true,
        model: (overrides.model as string | undefined) ?? null,
        historySize: Number(modeConfig.history_size ?? this.commandConfig.history_size),
      },
    ];
  }

  triggerForLabel(label: string): string {
    return this.classifierLabelToTrigger[label] ?? this.classifierLabelToTrigger[this.fallbackClassifierLabel];
  }

  static normalizeServerTag(serverTag: string): string {
    if (serverTag.startsWith("discord:")) {
      return serverTag.split("discord:", 2)[1];
    }
    if (serverTag.startsWith("slack:")) {
      return serverTag.split("slack:", 2)[1];
    }
    return serverTag;
  }

  static channelKey(serverTag: string, channelName: string): string {
    return `${CommandResolver.normalizeServerTag(serverTag)}#${channelName}`;
  }

  getChannelMode(serverTag: string, channelName: string): string {
    const channelModes = this.commandConfig.channel_modes ?? {};
    const key = CommandResolver.channelKey(serverTag, channelName);
    return channelModes[key] ?? this.commandConfig.default_mode ?? "classifier";
  }

  shouldBypassSteeringQueue(message: RoomMessage): boolean {
    const parsed = this.parsePrefix(message.content);

    if (parsed.error || parsed.noContext) {
      return true;
    }

    if (parsed.modeToken === this.helpToken) {
      return true;
    }

    if (parsed.modeToken) {
      const [, runtime] = this.runtimeForTrigger(parsed.modeToken);
      return !runtime.steering;
    }

    const channelMode = this.getChannelMode(message.serverTag, message.channelName);
    let trigger = channelMode;

    if (!this.triggerToMode[trigger] && this.commandConfig.modes[trigger]) {
      trigger = this.defaultTriggerByMode[trigger];
    }

    if (this.triggerToMode[trigger]) {
      const [, runtime] = this.runtimeForTrigger(trigger);
      return !runtime.steering;
    }

    return false;
  }

  buildHelpMessage(serverTag: string, channelName: string): string {
    const channelMode = this.getChannelMode(serverTag, channelName);
    const classifierModel = this.commandConfig.mode_classifier.model;

    const defaultDescription = this.describeDefaultMode(channelMode, classifierModel);

    const modeParts = Object.entries(this.commandConfig.modes)
      .flatMap(([modeKey, modeConfig]) => {
        const triggers = Object.keys(modeConfig.triggers);
        if (triggers.length === 0) {
          return [];
        }

        const modelDescription = modeConfig.model ? this.modelNameFormatter(modeConfig.model) : "";
        return [`${triggers.join("/")} = ${modeKey} (${modelDescription})`];
      })
      .join(", ");

    return `${
      `default is ${defaultDescription}; modes: ${modeParts}; `
    }use @modelid to override model; !c disables context`;
  }

  async resolve(input: {
    message: RoomMessage;
    context: Array<{ role: string; content: string }>;
    defaultSize: number;
  }): Promise<ResolvedCommand> {
    const parsed = this.parsePrefix(input.message.content);
    if (parsed.error) {
      return {
        noContext: parsed.noContext,
        queryText: parsed.queryText,
        modelOverride: parsed.modelOverride,
        selectedLabel: null,
        selectedTrigger: null,
        modeKey: null,
        runtime: null,
        error: parsed.error,
        helpRequested: false,
        selectedAutomatically: false,
      };
    }

    if (parsed.modeToken === this.helpToken) {
      return {
        noContext: parsed.noContext,
        queryText: parsed.queryText,
        modelOverride: parsed.modelOverride,
        selectedLabel: null,
        selectedTrigger: null,
        modeKey: null,
        runtime: null,
        helpRequested: true,
        selectedAutomatically: false,
      };
    }

    if (parsed.modeToken) {
      const [modeKey, runtime] = this.runtimeForTrigger(parsed.modeToken);
      return {
        noContext: parsed.noContext,
        queryText: parsed.queryText,
        modelOverride: parsed.modelOverride,
        selectedLabel: parsed.modeToken,
        selectedTrigger: parsed.modeToken,
        modeKey,
        runtime,
        helpRequested: false,
        selectedAutomatically: false,
      };
    }

    const channelMode = this.getChannelMode(input.message.serverTag, input.message.channelName);

    let selectedLabel: string;
    let selectedTrigger: string;

    if (channelMode === "classifier") {
      selectedLabel = await this.classifyMode(input.context);
      selectedTrigger = this.triggerForLabel(selectedLabel);
    } else if (channelMode.startsWith("classifier:")) {
      const constrainedMode = channelMode.split(":", 2)[1];
      if (!this.commandConfig.modes[constrainedMode]) {
        return {
          noContext: parsed.noContext,
          queryText: parsed.queryText,
          modelOverride: parsed.modelOverride,
          selectedLabel: null,
          selectedTrigger: null,
          modeKey: null,
          runtime: null,
          error: `Unknown channel mode policy '${channelMode}': mode '${constrainedMode}' missing`,
          helpRequested: false,
          channelMode,
          selectedAutomatically: true,
        };
      }

      selectedLabel = await this.classifyMode(input.context.slice(-input.defaultSize));
      selectedTrigger = this.triggerForLabel(selectedLabel);
      const [selectedMode] = this.runtimeForTrigger(selectedTrigger);
      if (selectedMode !== constrainedMode) {
        selectedTrigger = this.defaultTriggerByMode[constrainedMode];
        selectedLabel = selectedTrigger;
      }
    } else if (this.triggerToMode[channelMode]) {
      selectedTrigger = channelMode;
      selectedLabel = selectedTrigger;
    } else if (this.commandConfig.modes[channelMode]) {
      selectedTrigger = this.defaultTriggerByMode[channelMode];
      selectedLabel = selectedTrigger;
    } else {
      return {
        noContext: parsed.noContext,
        queryText: parsed.queryText,
        modelOverride: parsed.modelOverride,
        selectedLabel: null,
        selectedTrigger: null,
        modeKey: null,
        runtime: null,
        error: `Unknown channel mode policy '${channelMode}'`,
        helpRequested: false,
        channelMode,
        selectedAutomatically: true,
      };
    }

    const [modeKey, runtime] = this.runtimeForTrigger(selectedTrigger);

    return {
      noContext: parsed.noContext,
      queryText: parsed.queryText,
      modelOverride: parsed.modelOverride,
      selectedLabel,
      selectedTrigger,
      modeKey,
      runtime,
      helpRequested: false,
      channelMode,
      selectedAutomatically: true,
    };
  }

  private async classifyMode(context: Array<{ role: string; content: string }>): Promise<string> {
    return this.classifyModeFn(context);
  }

  private describeDefaultMode(channelMode: string, classifierModel: string): string {
    if (channelMode === "classifier") {
      return `automatic mode (${classifierModel} decides)`;
    }

    if (channelMode.startsWith("classifier:")) {
      return `automatic mode constrained to ${channelMode.split(":", 2)[1]}`;
    }

    if (this.triggerToMode[channelMode]) {
      return `forced trigger ${channelMode} (${this.triggerToMode[channelMode]})`;
    }

    return `${channelMode} mode`;
  }
}
