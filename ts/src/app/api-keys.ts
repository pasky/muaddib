export type ApiKeyResolver = (
  provider: string,
) => Promise<string | undefined> | string | undefined;

const UNSUPPORTED_REFRESH_FIELDS = ["oauth", "session"] as const;

/**
 * Resolve provider API keys from muaddib config providers.*.key fields.
 *
 * Supported contract in TS runtime:
 * - providers.<provider>.key: non-empty string (static key)
 * - provider SDK env vars (when no key is provided)
 *
 * OAuth/session-backed refresh credentials are intentionally fail-fast for now
 * to avoid ambiguous operator behavior.
 */
export function createConfigApiKeyResolver(config: Record<string, unknown>): ApiKeyResolver {
  const providers = (config.providers as Record<string, unknown> | undefined) ?? {};
  const staticKeys = new Map<string, string>();
  const unsupportedPaths: string[] = [];

  for (const [provider, rawProviderConfig] of Object.entries(providers)) {
    if (!isRecord(rawProviderConfig)) {
      continue;
    }

    const key = rawProviderConfig.key;
    if (key !== undefined && key !== null) {
      if (typeof key !== "string") {
        unsupportedPaths.push(`providers.${provider}.key`);
      } else {
        const trimmedKey = key.trim();
        if (trimmedKey.length > 0) {
          staticKeys.set(provider, trimmedKey);
        }
      }
    }

    for (const field of UNSUPPORTED_REFRESH_FIELDS) {
      const refreshConfig = rawProviderConfig[field];
      if (refreshConfig !== undefined && refreshConfig !== null) {
        unsupportedPaths.push(`providers.${provider}.${field}`);
      }
    }
  }

  if (unsupportedPaths.length > 0) {
    const uniquePaths = Array.from(new Set(unsupportedPaths));
    throw new Error(
      "Unsupported provider API credential config in the TypeScript runtime. " +
        "Supported contract: providers.<provider>.key as a static non-empty string (or provider env vars). " +
        `Remove unsupported credential fields: ${uniquePaths.join(", ")}. ` +
        "OAuth/session refresh flows are not implemented yet.",
    );
  }

  return (provider: string): string | undefined => staticKeys.get(provider);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
