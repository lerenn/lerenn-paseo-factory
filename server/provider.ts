import { PR_FACTS_PROVIDER_KEY, PROVIDER_ID, type PrFactsProvider } from "../shared/facts";
import { ghDiff, ghFacts, isGitHubPrUrl } from "./github";

/** The GitHub provider: the same `gh` reads the Factory falls back to, offered through the registry. */
export const githubProvider: PrFactsProvider = { matches: isGitHubPrUrl, prFacts: ghFacts, prDiff: ghDiff };

/**
 * Offers `provider` on `globalThis[Symbol.for("paseo.pr-facts")]` under the id `github`, keeping other providers. Returns the
 * cleanup: it removes the entry only while it is still this one (a reload that registered again is left alone).
 */
export function registerProvider(provider: PrFactsProvider = githubProvider, target: Record<symbol, unknown> = globalThis as Record<symbol, unknown>): () => void {
  const registry = ((target[PR_FACTS_PROVIDER_KEY] as Record<string, PrFactsProvider> | undefined) ??= {});
  registry[PROVIDER_ID] = provider;
  return () => {
    const now = target[PR_FACTS_PROVIDER_KEY] as Record<string, PrFactsProvider> | undefined;
    if (now?.[PROVIDER_ID] === provider) delete now[PROVIDER_ID];
  };
}
