import { join } from "node:path";

import {
  AuthStorage,
  type AuthCredential,
} from "@earendil-works/pi-coding-agent";

import { buildArc } from "../rooms/message.js";

export interface ParsedSetKeyArgs {
  provider: string;
  key: string | null;
}

export function buildUserArc(serverTag: string, nick: string): string {
  return buildArc(serverTag, nick);
}

export function parseSetKeyArgs(queryText: string): ParsedSetKeyArgs | null {
  const trimmed = queryText.trim();
  if (!trimmed) {
    return null;
  }

  const [providerToken, ...rest] = trimmed.split(/\s+/);
  if (!providerToken) {
    return null;
  }

  const key = rest.join(" ").trim();
  return {
    provider: providerToken,
    key: key || null,
  };
}

export class UserKeyStore {
  constructor(private readonly muaddibHome: string) {}

  getOpenRouterKey(userArc: string): string | null {
    const storage = this.storageFor(userArc);
    this.throwOnLoadErrors(storage, userArc);
    const credential = storage.get("openrouter");
    if (!credential) {
      return null;
    }
    if (credential.type !== "api_key") {
      throw new Error(`users/${userArc}/auth.json openrouter credential must be an api_key.`);
    }
    return credential.key;
  }

  setOpenRouterKey(userArc: string, key: string): void {
    this.storageFor(userArc).set("openrouter", {
      type: "api_key",
      key,
    });
  }

  clearOpenRouterKey(userArc: string): void {
    this.storageFor(userArc).remove("openrouter");
  }

  private storageFor(userArc: string): AuthStorage {
    return AuthStorage.create(join(this.muaddibHome, "users", userArc, "auth.json"));
  }

  private throwOnLoadErrors(storage: AuthStorage, userArc: string): void {
    const errors = storage.drainErrors();
    if (errors.length > 0) {
      throw new Error(`Failed to load users/${userArc}/auth.json: ${errors[0].message}`);
    }
  }
}

/**
 * Wrap a base {@link AuthStorage} so the `openrouter` provider resolves to a
 * per-session key, while every other provider — and any method not listed here
 * (e.g. `getProviderEnv`, `getAuthStatus`, OAuth) — delegates to the base
 * instance unchanged.
 *
 * `AuthStorage` is a class with private state and a private constructor, so it
 * cannot be subclassed or duck-typed. A `Proxy` over the real instance keeps
 * its class identity, forwards unknown members verbatim (future-proof), and
 * only intercepts the openrouter-aware accessors below.
 */
export function createOpenRouterAuthStorageOverride(
  baseAuthStorage: AuthStorage,
  openRouterKey: string,
): AuthStorage {
  let overrideKey: string | undefined = openRouterKey;

  const getOverrideCredential = (): AuthCredential | undefined =>
    overrideKey ? { type: "api_key", key: overrideKey } : undefined;

  const overrides: Partial<AuthStorage> = {
    get: (provider: string) =>
      provider === "openrouter" ? getOverrideCredential() : baseAuthStorage.get(provider),
    set: (provider: string, credential: AuthCredential) => {
      if (provider === "openrouter") {
        if (credential.type !== "api_key") {
          throw new Error("Per-session OpenRouter overrides only support api_key credentials.");
        }
        overrideKey = credential.key;
        return;
      }
      baseAuthStorage.set(provider, credential);
    },
    remove: (provider: string) => {
      if (provider === "openrouter") {
        overrideKey = undefined;
        return;
      }
      baseAuthStorage.remove(provider);
    },
    list: () => {
      const providers = new Set(baseAuthStorage.list());
      if (overrideKey) {
        providers.add("openrouter");
      }
      return [...providers];
    },
    has: (provider: string) =>
      provider === "openrouter" ? overrideKey !== undefined : baseAuthStorage.has(provider),
    hasAuth: (provider: string) =>
      provider === "openrouter"
        ? overrideKey !== undefined || baseAuthStorage.hasAuth(provider)
        : baseAuthStorage.hasAuth(provider),
    getAll: () => {
      const data = baseAuthStorage.getAll();
      const credential = getOverrideCredential();
      if (credential) {
        data.openrouter = credential;
      }
      return data;
    },
    logout: (provider: string) => {
      if (provider === "openrouter") {
        overrideKey = undefined;
        return;
      }
      baseAuthStorage.logout(provider);
    },
    getApiKey: (provider: string, options) =>
      provider === "openrouter"
        ? Promise.resolve(overrideKey ?? baseAuthStorage.getApiKey(provider, options))
        : baseAuthStorage.getApiKey(provider, options),
    setRuntimeApiKey: (provider: string, apiKey: string) => {
      if (provider === "openrouter") {
        overrideKey = apiKey;
        return;
      }
      baseAuthStorage.setRuntimeApiKey(provider, apiKey);
    },
    removeRuntimeApiKey: (provider: string) => {
      if (provider === "openrouter") {
        overrideKey = undefined;
        return;
      }
      baseAuthStorage.removeRuntimeApiKey(provider);
    },
  };

  return new Proxy(baseAuthStorage, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return overrides[prop as keyof AuthStorage];
      }
      // Resolve with `target` as receiver so any class accessors that read
      // private fields run against the real instance, not the proxy.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
