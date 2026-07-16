import { join } from "node:path";

import { loadCredentialsFile, saveCredentialsFile } from "../auth/auth-store.js";
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
    const credential = this.load(userArc).openrouter;
    if (!credential) {
      return null;
    }
    if (credential.type !== "api_key") {
      throw new Error(`users/${userArc}/auth.json openrouter credential must be an api_key.`);
    }
    return credential.key ?? null;
  }

  setOpenRouterKey(userArc: string, key: string): void {
    const data = this.load(userArc);
    data.openrouter = { type: "api_key", key };
    saveCredentialsFile(this.pathFor(userArc), data);
  }

  clearOpenRouterKey(userArc: string): void {
    const data = this.load(userArc);
    if (!("openrouter" in data)) {
      return;
    }
    delete data.openrouter;
    saveCredentialsFile(this.pathFor(userArc), data);
  }

  private pathFor(userArc: string): string {
    return join(this.muaddibHome, "users", userArc, "auth.json");
  }

  private load(userArc: string) {
    try {
      return loadCredentialsFile(this.pathFor(userArc));
    } catch (error) {
      throw new Error(
        `Failed to load users/${userArc}/auth.json: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}
