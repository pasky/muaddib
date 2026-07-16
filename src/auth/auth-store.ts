import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type CredentialData = Record<string, Credential>;

/** Load an auth.json-style credential file. Throws on malformed content. */
export function loadCredentialsFile(path: string): CredentialData {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Failed to parse ${path}: expected a JSON object of provider credentials.`);
  }
  return parsed as CredentialData;
}

/** Atomically write an auth.json-style credential file (0600, tmp+rename). */
export function saveCredentialsFile(path: string, data: CredentialData): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, path);
}

function toCredentialInfos(data: CredentialData): CredentialInfo[] {
  return Object.entries(data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
}

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Resolve a configured api_key value the way pi's removed AuthStorage did:
 * `!command` executes a shell command (10s timeout, trimmed stdout), and
 * `$NAME`/`${NAME}` templates resolve from `credential.env` then
 * `process.env` (`$$`/`$!` escape a literal `$`/`!`). Returns undefined when
 * a command fails or a referenced env var is unset, which callers treat as
 * "not configured".
 */
function resolveConfigValue(value: string, env?: Record<string, string>): string | undefined {
  if (value.startsWith("!")) {
    try {
      const output = execSync(value.slice(1), { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
      return output.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  let resolved = "";
  let index = 0;
  while (index < value.length) {
    const dollarIndex = value.indexOf("$", index);
    if (dollarIndex < 0) {
      resolved += value.slice(index);
      break;
    }
    resolved += value.slice(index, dollarIndex);
    const nextChar = value[dollarIndex + 1];
    if (nextChar === "$" || nextChar === "!") {
      resolved += nextChar;
      index = dollarIndex + 2;
      continue;
    }
    let name: string | undefined;
    if (nextChar === "{") {
      const endIndex = value.indexOf("}", dollarIndex + 2);
      const candidate = endIndex >= 0 ? value.slice(dollarIndex + 2, endIndex) : undefined;
      if (candidate !== undefined && ENV_VAR_NAME_RE.test(candidate)) {
        name = candidate;
        index = endIndex + 1;
      }
    } else {
      const match = value.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
      if (match) {
        name = match[0];
        index = dollarIndex + 1 + match[0].length;
      }
    }
    if (name === undefined) {
      resolved += "$";
      index = dollarIndex + 1;
      continue;
    }
    const envValue = env?.[name] || process.env[name] || undefined;
    if (envValue === undefined) {
      return undefined;
    }
    resolved += envValue;
  }
  return resolved;
}

/** Apply configured-value resolution to a stored api_key credential on read. */
function resolveCredentialKey(credential: Credential | undefined): Credential | undefined {
  if (credential?.type !== "api_key" || credential.key === undefined) {
    return credential;
  }
  return { ...credential, key: resolveConfigValue(credential.key, credential.env as Record<string, string> | undefined) };
}

/**
 * pi-ai CredentialStore backed by a muaddib-owned auth.json file.
 *
 * FIXME: unlike pi's removed AuthStorage, this store has no cross-process
 * file lock: concurrent muaddib processes sharing one auth.json (e.g. the
 * service plus a cli:message run) can race an OAuth refresh read-modify-write
 * and lose one write — fatal if the provider rotates refresh tokens. Writes
 * are only serialized within this process; the tmp file is pid-suffixed so
 * concurrent writers cannot corrupt each other's rename.
 */
class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  /** Serialize writes through a promise chain. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(
      () => task(),
      () => task(),
    );
    this.chain = next.catch(() => {});
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return resolveCredentialKey(loadCredentialsFile(this.path)[providerId]);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return toCredentialInfos(loadCredentialsFile(this.path));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const data = loadCredentialsFile(this.path);
      const next = await fn(data[providerId]);
      if (next === undefined) {
        return data[providerId];
      }
      data[providerId] = next;
      saveCredentialsFile(this.path, data);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(async () => {
      const data = loadCredentialsFile(this.path);
      if (!(providerId in data)) {
        return;
      }
      delete data[providerId];
      saveCredentialsFile(this.path, data);
    });
  }
}

/** In-memory CredentialStore seeded synchronously (for tests and overrides). */
class MemoryCredentialStore implements CredentialStore {
  private readonly credentials: Map<string, Credential>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(data: CredentialData = {}) {
    this.credentials = new Map(Object.entries(data));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(
      () => task(),
      () => task(),
    );
    this.chain = next.catch(() => {});
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return resolveCredentialKey(this.credentials.get(providerId));
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return toCredentialInfos(Object.fromEntries(this.credentials));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const current = this.credentials.get(providerId);
      const next = await fn(current);
      if (next === undefined) {
        return current;
      }
      this.credentials.set(providerId, next);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(async () => {
      this.credentials.delete(providerId);
    });
  }
}

/**
 * CredentialStore that pins one provider to a fixed credential (e.g. a
 * per-session OpenRouter BYOK key) while delegating every other provider to
 * the base store, so OAuth refreshes for other providers still persist there.
 */
class OverrideCredentialStore implements CredentialStore {
  constructor(
    private readonly base: CredentialStore,
    private readonly providerId: string,
    private credential: Credential,
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === this.providerId ? this.credential : this.base.read(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const infos = (await this.base.list()).filter((info) => info.providerId !== this.providerId);
    return [...infos, { providerId: this.providerId, type: this.credential.type }];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== this.providerId) {
      return this.base.modify(providerId, fn);
    }
    const next = await fn(this.credential);
    if (next !== undefined) {
      this.credential = next;
    }
    return this.credential;
  }

  async delete(providerId: string): Promise<void> {
    if (providerId !== this.providerId) {
      return this.base.delete(providerId);
    }
    throw new Error(`Cannot delete overridden '${this.providerId}' credential from a session-scoped auth store.`);
  }
}

/**
 * Muaddib's provider auth facade, replacing pi-coding-agent's removed
 * `AuthStorage` (pi 0.80.8). Owns the credential store and lazily builds the
 * `ModelRuntime` that `AgentSession` requires (offline: no models.json, no
 * catalog network refresh). `getApiKey` resolves plain stored api_key
 * credentials directly and defers to the ModelRuntime for everything else
 * (OAuth refresh, env-var fallback for known providers).
 */
export class AuthStore {
  private modelRuntimePromise?: Promise<ModelRuntime>;

  private constructor(readonly credentials: CredentialStore) {}

  static create(authPath: string): AuthStore {
    return new AuthStore(new FileCredentialStore(authPath));
  }

  static inMemory(data: CredentialData = {}): AuthStore {
    return new AuthStore(new MemoryCredentialStore(data));
  }

  getModelRuntime(): Promise<ModelRuntime> {
    this.modelRuntimePromise ??= ModelRuntime.create({
      credentials: this.credentials,
      modelsPath: null,
      allowModelNetwork: false,
    });
    return this.modelRuntimePromise;
  }

  async getApiKey(provider: string): Promise<string | undefined> {
    const credential = await this.credentials.read(provider);
    if (credential?.type === "api_key" && credential.key) {
      return credential.key;
    }
    const runtime = await this.getModelRuntime();
    const resolved = await runtime.getAuth(provider);
    return resolved?.auth.apiKey;
  }

  /** A session-scoped view of this store with the `openrouter` key replaced. */
  withOpenRouterOverride(key: string): AuthStore {
    return new AuthStore(new OverrideCredentialStore(this.credentials, "openrouter", { type: "api_key", key }));
  }
}
