import type { DiffSummary } from "./github";
import type { PrFacts } from "./engine";

/**
 * Where the Factory reads pull request facts. Plugins share a process, so a forge plugin (paseo-factory-github) offers a
 * provider on `globalThis[Symbol.for("paseo.pr-facts")]`: a registry keyed by provider id, each entry a `PrFactsProvider`.
 * A URL goes to the first provider that `matches` it; with none, to the Factory's own `gh` reads (`github.ts`), so the Factory
 * behaves the same with or without the plugin. A provider that throws is not replaced by the fallback: its error is the
 * answer (the engine treats it like a failed `gh` read: "facts unavailable", a verdict to retry, a wait that polls again).
 * The engine keeps the per-URL cache and the merge-wait logic (left-queue, re-arm); a provider only reads.
 */
export const PR_FACTS_PROVIDER_KEY = Symbol.for("paseo.pr-facts");

export interface PrFactsProvider {
  /** The pull request URLs this provider reads (for example `https://github.com/<owner>/<repo>/pull/<n>`). */
  matches(url: string): boolean;
  /** Facts of one PR, read now (the Factory caches them). A PR that does not exist is `exists: false`, not an error. */
  prFacts(url: string): Promise<PrFacts>;
  /** Files changed and lines added or removed (the Run diff screen). Absent: the fallback's. */
  prDiff?(url: string): Promise<DiffSummary>;
}

/** What the Factory does without a provider (its own `gh` reads). */
export interface FactsFallback {
  prFacts(url: string): Promise<PrFacts>;
  prDiff(url: string): Promise<DiffSummary>;
  matches(url: string): boolean;
}

/** The provider registered for `url`, or null. */
export function factsProvider(url: string, target: Record<symbol, unknown> = globalThis as Record<symbol, unknown>): PrFactsProvider | null {
  const registry = target[PR_FACTS_PROVIDER_KEY] as Record<string, PrFactsProvider | undefined> | undefined;
  for (const p of Object.values(registry ?? {})) {
    if (p && typeof p.matches === "function" && typeof p.prFacts === "function" && p.matches(url)) return p;
  }
  return null;
}

const STATES = new Set(["open", "closed", "merged"]);
const CI = new Set(["green", "red", "pending", "none"]);

/** A provider's answer must be facts the engine can act on: a malformed one is an error, never a guess. */
function checked(url: string, f: PrFacts): PrFacts {
  if (!f || typeof f !== "object" || !STATES.has(f.state) || !CI.has(f.ci) || typeof f.head !== "string" || typeof f.exists !== "boolean") {
    throw new Error(`the facts provider gave malformed facts for ${url}`);
  }
  return { ...f, url };
}

/** The Factory's reads: the matching provider's when one is registered, else the fallback's. Resolved per call. */
export function factsSource(fallback: FactsFallback, target: Record<symbol, unknown> = globalThis as Record<symbol, unknown>) {
  return {
    async prFacts(url: string): Promise<PrFacts> {
      const p = factsProvider(url, target);
      return p ? checked(url, await p.prFacts(url)) : fallback.prFacts(url);
    },
    async prDiff(url: string): Promise<DiffSummary> {
      const p = factsProvider(url, target);
      return p?.prDiff ? p.prDiff(url) : fallback.prDiff(url);
    },
    /** A URL the Factory can read facts of: a provider's, or the fallback's (a GitHub PR URL). */
    isPrUrl(url: string): boolean {
      return factsProvider(url, target) !== null || fallback.matches(url);
    },
  };
}
