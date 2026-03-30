import type { AuthStorage } from "@mariozechner/pi-coding-agent";

import type {
  GondolinConfig,
  GondolinEnvValue,
  GondolinSecretEnvConfig,
} from "../../config/muaddib-config.js";
import type { VmSecretDefinition } from "./network.js";
import { asRecord, escapeRegExp } from "../../utils/index.js";

export interface ResolvedGondolinEnv {
  humanArc: string | null;
  plainEnv: Record<string, string>;
  secretEnv: Record<string, VmSecretDefinition>;
  urlAllowRegexes: RegExp[];
}

interface ResolveGondolinArcOptions {
  config: GondolinConfig;
  serverTag?: string;
  channelName?: string;
}

interface ResolveGondolinEnvOptions extends ResolveGondolinArcOptions {
  authStorage?: AuthStorage;
}

interface ResolvedGondolinArcFragments {
  humanArc: string | null;
  env: Record<string, GondolinEnvValue>;
  urlAllowRegexes: RegExp[];
}

export function resolveUrlAllowRegexes(options: ResolveGondolinArcOptions): RegExp[] {
  return resolveGondolinArcFragments(options).urlAllowRegexes;
}

export async function resolveGondolinEnv(options: ResolveGondolinEnvOptions): Promise<ResolvedGondolinEnv> {
  const { humanArc, env, urlAllowRegexes } = resolveGondolinArcFragments(options);

  const plainEnv: Record<string, string> = {};
  const secretEnv: Record<string, VmSecretDefinition> = {};

  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string") {
      plainEnv[name] = value;
      continue;
    }

    if (!options.authStorage) {
      throw new Error(
        `Gondolin env var ${name} references auth provider '${value.provider}', but authStorage is unavailable.`,
      );
    }

    const apiKey = await options.authStorage.getApiKey(value.provider);
    if (!apiKey) {
      throw new Error(
        `Gondolin env var ${name} references auth provider '${value.provider}', but no API key is configured in auth.json.`,
      );
    }

    secretEnv[name] = {
      hosts: [...value.hosts],
      value: apiKey,
    };
  }

  return { humanArc, plainEnv, secretEnv, urlAllowRegexes };
}

function resolveGondolinArcFragments(options: ResolveGondolinArcOptions): ResolvedGondolinArcFragments {
  const humanArc =
    typeof options.serverTag === "string" && typeof options.channelName === "string"
      ? `${options.serverTag}#${options.channelName}`
      : null;

  const profiles = options.config.profiles === undefined
    ? {}
    : asRecord(options.config.profiles) ?? fail("agent.tools.gondolin.profiles must be an object");
  const arcs = options.config.arcs === undefined
    ? {}
    : asRecord(options.config.arcs) ?? fail("agent.tools.gondolin.arcs must be an object");

  const env: Record<string, GondolinEnvValue> = {};
  const urlAllowRegexes: RegExp[] = [];

  const matchingArcs = Object.entries(arcs)
    .filter(([pattern]) => !pattern.startsWith("_comment"))
    .filter(([pattern]) => {
      if (pattern.length === 0) {
        throw new Error("agent.tools.gondolin.arcs keys must not be empty");
      }
      return pattern === "*" || (humanArc !== null && matchesArcPattern(pattern, humanArc));
    })
    .sort(([left], [right]) => compareArcSpecificity(left, right));

  for (const [pattern, arcValue] of matchingArcs) {
    const arcPath = `agent.tools.gondolin.arcs.${pattern}`;
    const arc = asRecord(arcValue);
    if (!arc) {
      throw new Error(`${arcPath} must be an object`);
    }

    const use = arc.use === undefined
      ? []
      : Array.isArray(arc.use) && arc.use.every((item) => typeof item === "string" && item.length > 0)
        ? [...arc.use]
        : fail(`${arcPath}.use must be an array of non-empty profile names`);

    for (const profileName of use) {
      const profilePath = `agent.tools.gondolin.profiles.${profileName}`;
      const profile = asRecord(profiles[profileName]);
      if (!profile) {
        throw new Error(`${arcPath}.use references unknown profile '${profileName}'`);
      }
      if (profile.use !== undefined) {
        throw new Error(`${profilePath}.use is not supported; Gondolin profiles cannot inherit from other profiles`);
      }
      Object.assign(env, readEnv(profile.env, `${profilePath}.env`));
      urlAllowRegexes.push(...readUrlAllowRegexes(profile.urlAllowRegexes, `${profilePath}.urlAllowRegexes`));
    }

    Object.assign(env, readEnv(arc.env, `${arcPath}.env`));
    urlAllowRegexes.push(...readUrlAllowRegexes(arc.urlAllowRegexes, `${arcPath}.urlAllowRegexes`));
  }

  return { humanArc, env, urlAllowRegexes };
}

function readEnv(value: unknown, path: string): Record<string, GondolinEnvValue> {
  if (value === undefined) {
    return {};
  }

  const record = asRecord(value);
  if (!record) {
    throw new Error(`${path} must be an object`);
  }

  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !key.startsWith("_comment"))
      .map(([name, envValue]) => [name, readEnvValue(envValue, `${path}.${name}`)]),
  );
}

function readUrlAllowRegexes(value: unknown, path: string): RegExp[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of non-empty regex strings`);
  }

  return value.map((entry, index) => compileUrlAllowRegex(entry, `${path}[${index}]`));
}

function compileUrlAllowRegex(value: unknown, path: string): RegExp {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty regex string`);
  }

  try {
    return new RegExp(value, "u");
  } catch (error) {
    throw new Error(
      `${path} must be a valid JavaScript regular expression source: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function readEnvValue(value: unknown, path: string): GondolinEnvValue {
  if (typeof value === "string") {
    return value;
  }

  const record = asRecord(value);
  if (!record) {
    throw new Error(`${path} must be a string or { provider, hosts } object`);
  }

  const provider = record.provider;
  if (typeof provider !== "string" || provider.length === 0) {
    throw new Error(`${path}.provider must be a non-empty string`);
  }

  const hosts = record.hosts;
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.some((host) => typeof host !== "string" || host.length === 0)) {
    throw new Error(`${path}.hosts must be a non-empty array of host patterns`);
  }

  return { provider, hosts: [...hosts] } satisfies GondolinSecretEnvConfig;
}

function matchesArcPattern(pattern: string, humanArc: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "u");
  return regex.test(humanArc);
}

function compareArcSpecificity(left: string, right: string): number {
  const leftWildcards = left === "*" ? 1 : left.split("").filter((char) => char === "*").length;
  const rightWildcards = right === "*" ? 1 : right.split("").filter((char) => char === "*").length;
  const leftKind = left === "*" ? 0 : leftWildcards === 0 ? 2 : 1;
  const rightKind = right === "*" ? 0 : rightWildcards === 0 ? 2 : 1;

  return leftKind - rightKind ||
    left.replaceAll("*", "").length - right.replaceAll("*", "").length ||
    rightWildcards - leftWildcards;
}

function fail(message: string): never {
  throw new Error(message);
}
