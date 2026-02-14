import { MuaddibConfig } from "../config/muaddib-config.js";

export type ApiKeyResolver = (
  provider: string,
) => Promise<string | undefined> | string | undefined;

const PROVIDER_ENV_API_KEY: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

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
export function createConfigApiKeyResolver(config: MuaddibConfig): ApiKeyResolver {
  const { staticKeys: configuredKeys, unsupportedPaths } = config.getProviderCredentialConfig();
  const staticKeys = new Map<string, string>(Object.entries(configuredKeys));

  if (unsupportedPaths.length > 0) {
    const uniquePaths = Array.from(new Set(unsupportedPaths)).sort();
    throw new Error(
      "Unsupported provider API credential config in the TypeScript runtime. " +
        "Supported contract: providers.<provider>.key as a static non-empty string (or provider env vars). " +
        `Remove unsupported credential fields: ${uniquePaths.join(", ")}. ` +
        "OAuth/session refresh is intentionally deferred until provider-specific refresh contracts are implemented. " +
        buildOperatorGuidance(uniquePaths),
    );
  }

  return (provider: string): string | undefined => staticKeys.get(provider);
}

function buildOperatorGuidance(paths: string[]): string {
  const byProvider = new Map<string, string[]>();

  for (const path of paths) {
    const match = /^providers\.([^.]+)\./u.exec(path);
    if (!match) {
      continue;
    }

    const provider = match[1];
    const providerPaths = byProvider.get(provider) ?? [];
    providerPaths.push(path);
    byProvider.set(provider, providerPaths);
  }

  const guidance = Array.from(byProvider.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, providerPaths]) => {
      const uniqueProviderPaths = Array.from(new Set(providerPaths)).sort();
      const envVarHint = PROVIDER_ENV_API_KEY[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_API_KEY`;
      return `remove ${uniqueProviderPaths.join(", ")} and use providers.${provider}.key as a static string or ${envVarHint}`;
    });

  if (guidance.length === 0) {
    return "Operator guidance: remove unsupported credential keys and use providers.<provider>.key static values or provider SDK env vars.";
  }

  return `Operator guidance: ${guidance.join("; ")}.`;
}
