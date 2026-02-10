export type ApiKeyResolver = (
  provider: string,
) => Promise<string | undefined> | string | undefined;

/**
 * Resolve provider API keys from muaddib config providers.*.key fields.
 */
export function createConfigApiKeyResolver(config: Record<string, unknown>): ApiKeyResolver {
  const providers = (config.providers as Record<string, unknown> | undefined) ?? {};

  return (provider: string): string | undefined => {
    const providerConfig = providers[provider] as Record<string, unknown> | undefined;
    const key = providerConfig?.key;
    return typeof key === "string" && key.trim() ? key : undefined;
  };
}
