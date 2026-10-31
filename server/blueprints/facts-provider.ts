import type { DiffSummary } from "./github";
import type { PrFacts } from "./engine";

/**
 * Where the Factory reads pull request facts. Paseo runs each plugin in its own process, so a forge plugin (the lab's pr-facts)
 * offers its reads as read-only rpcs of a Factory extension, usually a remote one (`remote.ts`): `pr_facts` `{url}` → PrFacts or
 * null, and optionally `pr_diff` `{url}` → DiffSummary or null. The rpc is looked up on every read among the registered
 * extensions. A null answer (the provider does not read that URL), an error, a timeout or malformed facts falls back to the
 * Factory's own `gh` reads (`github.ts`), so the Factory behaves the same with or without the plugin, and a provider outage
 * costs a `gh` read, never a failed one. A `gh` error with `status` 429/5xx, a network `code` or `transient: true` (or a
 * message saying so) is transient (`transient.ts`): retried with back-off, never a failed run.
 * The engine keeps the per-URL cache and the merge-wait logic (left-queue, re-arm); a provider only reads.
 */
export const PR_FACTS_RPC = "pr_facts";
export const PR_DIFF_RPC = "pr_diff";
/** How long the Factory waits for a provider's answer before it reads through `gh`. */
export const FACTS_RPC_TIMEOUT_MS = 45_000;

/** Calls the read-only rpc `name` of the extension that offers it, or answers null when none does (resolved per call). */
export type FactsRpc = (name: string, input: { url: string }) => Promise<unknown> | null;

/** What the Factory does without a provider (its own `gh` reads). */
export interface FactsFallback {
  prFacts(url: string): Promise<PrFacts>;
  prDiff(url: string): Promise<DiffSummary>;
  matches(url: string): boolean;
}

export interface FactsSourceOptions {
  timeoutMs?: number;
  log?(message: string): void;
}

const STATES = new Set(["open", "closed", "merged"]);
const CI = new Set(["green", "red", "pending", "none"]);

/** A provider's answer must be facts the engine can act on: a malformed one is refused, never a guess. */
function checkedFacts(url: string, f: PrFacts): PrFacts {
  if (!f || typeof f !== "object" || !STATES.has(f.state) || !CI.has(f.ci) || typeof f.head !== "string" || typeof f.exists !== "boolean") {
    throw new Error(`the facts provider gave malformed facts for ${url}`);
  }
  return { ...f, url };
}

function checkedDiff(url: string, d: DiffSummary): DiffSummary {
  if (!d || typeof d !== "object" || ![d.files, d.additions, d.deletions].every((n) => typeof n === "number")) {
    throw new Error(`the facts provider gave a malformed diff for ${url}`);
  }
  return { files: d.files, additions: d.additions, deletions: d.deletions };
}

/** The Factory's reads: the provider rpc's answer when it gives one, else the fallback's. Resolved per call. */
export function factsSource(fallback: FactsFallback, rpc?: FactsRpc, options: FactsSourceOptions = {}) {
  const timeoutMs = options.timeoutMs ?? FACTS_RPC_TIMEOUT_MS;
  const log = options.log ?? ((m: string) => console.warn(m));
  /** Log the start and the end of a provider failure streak, not every failed read. */
  let failing = false;

  async function viaRpc<T>(name: string, url: string, check: (url: string, answer: T) => T): Promise<T | null> {
    let pending: Promise<unknown> | null;
    try {
      pending = rpc?.(name, { url }) ?? null;
    } catch (error) {
      pending = Promise.reject(error);
    }
    if (!pending) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
        }),
      ]);
      if (answer === null || answer === undefined) return null;
      const out = check(url, answer as T);
      if (failing) log(`factory: the facts provider answers again (${name} ${url})`);
      failing = false;
      return out;
    } catch (error) {
      if (!failing) log(`factory: the facts provider's ${name} failed for ${url}, reading through gh until it answers again: ${(error as Error).message}`);
      failing = true;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async prFacts(url: string): Promise<PrFacts> {
      return (await viaRpc<PrFacts>(PR_FACTS_RPC, url, checkedFacts)) ?? fallback.prFacts(url);
    },
    async prDiff(url: string): Promise<DiffSummary> {
      return (await viaRpc<DiffSummary>(PR_DIFF_RPC, url, checkedDiff)) ?? fallback.prDiff(url);
    },
    /** A URL the Factory can read facts of: one the fallback reads (a GitHub PR URL), as every rpc read can fall back to it. */
    isPrUrl(url: string): boolean {
      return fallback.matches(url);
    },
  };
}
