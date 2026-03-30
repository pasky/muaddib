import { join } from "node:path";

import {
  AuthStorage,
  type AuthCredential,
} from "@mariozechner/pi-coding-agent";

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
    const credential = this.storageFor(userArc).get("openrouter");
    if (!credential) {
      return null;
    }
    if (credential.type !== "api_key") {
      throw new Error(`users/${userArc}/auth.json openrouter credential must be an api_key.`);
    }
    return credential.key;
  }

  isExempt(userArc: string): boolean {
    const credential = this.storageFor(userArc).get("exempt");
    if (!credential) {
      return false;
    }
    if (credential.type !== "api_key") {
      throw new Error(`users/${userArc}/auth.json exempt credential must be an api_key.`);
    }
    return credential.key === "true";
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
}

export function createOpenRouterAuthStorageOverride(
  baseAuthStorage: AuthStorage,
  openRouterKey: string,
): AuthStorage {
  let overrideKey: string | undefined = openRouterKey;

  const getOverrideCredential = (): AuthCredential | undefined =>
    overrideKey
      ? {
          type: "api_key",
          key: overrideKey,
        }
      : undefined;

  return {
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
    drainErrors: () => baseAuthStorage.drainErrors(),
    login: (providerId, callbacks) => baseAuthStorage.login(providerId, callbacks),
    logout: (provider: string) => {
      if (provider === "openrouter") {
        overrideKey = undefined;
        return;
      }
      baseAuthStorage.logout(provider);
    },
    getApiKey: async (provider: string) =>
      provider === "openrouter"
        ? overrideKey ?? baseAuthStorage.getApiKey(provider)
        : baseAuthStorage.getApiKey(provider),
    getOAuthProviders: () => baseAuthStorage.getOAuthProviders(),
    reload: () => baseAuthStorage.reload(),
    setFallbackResolver: (resolver) => baseAuthStorage.setFallbackResolver(resolver),
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
  } as AuthStorage;
}
