/**
 * The Factory's PR facts contract (paseo-factory `server/blueprints/facts-provider.ts`). Plugins do not import each other, so
 * the shape is repeated here; keep it in step with the Factory's `PrFacts` and `PrFactsProvider`.
 */
export const PR_FACTS_PROVIDER_KEY = Symbol.for("paseo.pr-facts");
/** This plugin's entry in the registry. */
export const PROVIDER_ID = "github";

export interface PrFacts {
  url: string;
  exists: boolean;
  state: "open" | "closed" | "merged";
  head: string;
  ci: "green" | "red" | "pending" | "none";
  mergeable: boolean | null;
  draft: boolean;
  review: string;
  /** Auto-merge is on or the PR is in a merge queue: it merges by itself (absent: unknown). */
  queued?: boolean;
  /** Place in the merge queue (1 = next) and GitHub's estimate of the time left, in seconds (absent: not in a queue or unknown). */
  queuePosition?: number;
  queueEtaSeconds?: number;
}

export interface DiffSummary {
  files: number;
  additions: number;
  deletions: number;
}

export interface PrFactsProvider {
  matches(url: string): boolean;
  prFacts(url: string): Promise<PrFacts>;
  prDiff?(url: string): Promise<DiffSummary>;
}
