import { isIP } from "node:net";

import type { AuthStore } from "../../auth/auth-store.js";

import type {
  GondolinConfig,
  GondolinEnvValue,
  GondolinSecretEnvConfig,
  GondolinSshHostConfig,
} from "../../config/muaddib-config.js";
import type { VmSecretDefinition, VmSshHostDefinition } from "./network.js";
import { asRecord, escapeRegExp } from "../../utils/index.js";

export interface ResolvedGondolinEnv {
  humanArc: string | null;
  plainEnv: Record<string, string>;
  secretEnv: Record<string, VmSecretDefinition>;
  /** Keyed by canonical SSH target: "host", or "host:port" for non-default ports. */
  sshHosts: Record<string, VmSshHostDefinition>;
  urlAllowRegexes: RegExp[];
}

/** Validated ssh host config; host keys are decoded to their wire blobs. */
type SshHostFragment = Omit<GondolinSshHostConfig, "hostKeys"> & { hostKeys: Buffer[] };

interface ResolveGondolinArcOptions {
  config: GondolinConfig;
  serverTag?: string;
  channelName?: string;
}

interface ResolveGondolinEnvOptions extends ResolveGondolinArcOptions {
  authStorage?: AuthStore;
}

interface ResolvedGondolinArcFragments {
  humanArc: string | null;
  env: Record<string, GondolinEnvValue>;
  ssh: Record<string, SshHostFragment>;
  urlAllowRegexes: RegExp[];
}

export function resolveUrlAllowRegexes(options: ResolveGondolinArcOptions): RegExp[] {
  return resolveGondolinArcFragments(options).urlAllowRegexes;
}

/** Canonical SSH targets ("host" or "host:port") the arc's sandbox may reach. */
export function resolveSshTargets(options: ResolveGondolinArcOptions): string[] {
  return Object.keys(resolveGondolinArcFragments(options).ssh);
}

export async function resolveGondolinEnv(options: ResolveGondolinEnvOptions): Promise<ResolvedGondolinEnv> {
  const { humanArc, env, ssh, urlAllowRegexes } = resolveGondolinArcFragments(options);

  const readAuthKey = async (consumer: string, provider: string): Promise<string> => {
    if (!options.authStorage) {
      throw new Error(`${consumer} references auth provider '${provider}', but authStorage is unavailable.`);
    }
    const apiKey = await options.authStorage.getApiKey(provider);
    if (!apiKey) {
      throw new Error(`${consumer} references auth provider '${provider}', but no API key is configured in auth.json.`);
    }
    return apiKey;
  };

  const plainEnv: Record<string, string> = {};
  const secretEnv: Record<string, VmSecretDefinition> = {};

  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string") {
      plainEnv[name] = value;
      continue;
    }

    secretEnv[name] = {
      hosts: [...value.hosts],
      value: await readAuthKey(`Gondolin env var ${name}`, value.provider),
    };
  }

  const sshHosts: Record<string, VmSshHostDefinition> = {};
  for (const [target, { provider, username, hostKeys }] of Object.entries(ssh)) {
    sshHosts[target] = {
      username,
      privateKey: await readAuthKey(`Gondolin ssh host ${target}`, provider),
      hostKeys,
    };
  }

  return { humanArc, plainEnv, secretEnv, sshHosts, urlAllowRegexes };
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
  const ssh: Record<string, SshHostFragment> = {};
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
      Object.assign(ssh, readSsh(profile.ssh, `${profilePath}.ssh`));
      urlAllowRegexes.push(...readUrlAllowRegexes(profile.urlAllowRegexes, `${profilePath}.urlAllowRegexes`));
    }

    Object.assign(env, readEnv(arc.env, `${arcPath}.env`));
    Object.assign(ssh, readSsh(arc.ssh, `${arcPath}.ssh`));
    urlAllowRegexes.push(...readUrlAllowRegexes(arc.urlAllowRegexes, `${arcPath}.urlAllowRegexes`));
  }

  return { humanArc, env, ssh, urlAllowRegexes };
}

function readSsh(value: unknown, path: string): Record<string, SshHostFragment> {
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
      .map(([target, host]) => [readSshTarget(target, path), readSshHost(host, `${path}.${target}`)]),
  );
}

/**
 * Canonicalize an ssh config key to "host" (port 22) or "host:port".
 *
 * Gondolin routes SSH flows by the DNS name the guest looked up, so IP literals
 * can never match; wildcards are refused because host keys are pinned per host.
 */
function readSshTarget(target: string, path: string): string {
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]+))?$/u.exec(target);
  const port = match?.[2] === undefined ? 22 : Number(match[2]);
  if (!match || isIP(match[1]) !== 0 || port < 1 || port > 65535) {
    throw new Error(
      `${path} key ${JSON.stringify(target)} must be a lowercase hostname with an optional :PORT (no IP addresses or wildcards)`,
    );
  }
  return port === 22 ? match[1] : `${match[1]}:${port}`;
}

function readSshHost(value: unknown, path: string): SshHostFragment {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${path} must be a { provider, username, hostKeys } object`);
  }

  const { provider, username, hostKeys } = record;
  if (typeof provider !== "string" || provider.length === 0) {
    throw new Error(`${path}.provider must be a non-empty string`);
  }
  if (typeof username !== "string" || username.length === 0) {
    throw new Error(`${path}.username must be a non-empty string`);
  }
  if (!Array.isArray(hostKeys) || hostKeys.length === 0) {
    throw new Error(`${path}.hostKeys must be a non-empty array of SSH public keys`);
  }

  return {
    provider,
    username,
    hostKeys: hostKeys.map((key, index) => decodeSshPublicKey(key, `${path}.hostKeys[${index}]`)),
  };
}

/**
 * Decode "<type> <base64> [comment]" to the key's wire blob.
 *
 * The blob is a run of length-prefixed fields: the type name again, then the key material.
 * Checking that framing end to end catches a key cut short in pasting, which would otherwise
 * only show up later as a host key mismatch against a perfectly genuine server.
 */
function decodeSshPublicKey(value: unknown, path: string): Buffer {
  const [type, encoded] = typeof value === "string" ? value.trim().split(/\s+/u) : [];
  const blob = Buffer.from(encoded ?? "", "base64");
  const fields: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= blob.length && offset + 4 + blob.readUInt32BE(offset) <= blob.length) {
    const end = offset + 4 + blob.readUInt32BE(offset);
    fields.push(blob.subarray(offset + 4, end));
    offset = end;
  }
  if (!type || offset !== blob.length || fields.length < 2 || fields[0].toString("latin1") !== type) {
    throw new Error(
      `${path} must be an SSH public key of the form "<type> <base64>" (e.g. the last two columns of \`ssh-keyscan\` output)`,
    );
  }
  return blob;
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
