import type { PrFacts } from "./engine";

/** PR facts as last read from GitHub, with when. */
export type CachedPrFacts = PrFacts & { checkedAt: number };

export interface PrFactsCacheOptions {
  /** The uncached lookup (`ghFacts`). */
  fetch(url: string): Promise<PrFacts>;
  now?: () => number;
  /** A fact younger than this is served from memory (default 2 min). */
  ttlMs?: number;
  /** At most this many lookups run at once (default 4). */
  concurrency?: number;
}

export const PR_FACTS_TTL_MS = 2 * 60_000;
export const PR_FACTS_CONCURRENCY = 4;

/**
 * A per-URL cache in front of `ghFacts` (ADR "factory tickets view", decision 1aa2f981): a fact younger than `ttlMs` is
 * served from memory, a merged or closed PR is kept until no run refers to it any more (`prune`), concurrent lookups of one
 * URL share one call, and at most `concurrency` calls run at once. `maxAgeMs: 0` forces a fresh read (a gate that needs the
 * current head); a merged PR is final and never read again. Failures are not cached.
 */
export class PrFactsCache {
  private readonly facts = new Map<string, CachedPrFacts>();
  private readonly inflight = new Map<string, Promise<CachedPrFacts>>();
  private readonly queue: (() => void)[] = [];
  private running = 0;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly concurrency: number;

  constructor(private readonly options: PrFactsCacheOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PR_FACTS_TTL_MS;
    this.concurrency = Math.max(1, options.concurrency ?? PR_FACTS_CONCURRENCY);
  }

  /** Facts of `url`, from memory when fresh enough (`maxAgeMs`, default the TTL), else from GitHub. */
  async get(url: string, opts: { maxAgeMs?: number } = {}): Promise<CachedPrFacts> {
    const known = this.facts.get(url);
    if (known && this.fresh(known, opts.maxAgeMs ?? this.ttlMs)) return known;
    const pending = this.inflight.get(url);
    if (pending) return pending;
    const call = this.limited(() => this.options.fetch(url))
      .then((f) => {
        const entry: CachedPrFacts = { ...f, checkedAt: this.now() };
        this.facts.set(url, entry);
        return entry;
      })
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, call);
    return call;
  }

  /** The last known facts of `url`, never a lookup. */
  peek(url: string): CachedPrFacts | undefined {
    return this.facts.get(url);
  }

  /** Forget the PRs no run refers to any more. */
  prune(keep: Set<string>): void {
    for (const url of this.facts.keys()) if (!keep.has(url)) this.facts.delete(url);
  }

  get size(): number {
    return this.facts.size;
  }

  private fresh(f: CachedPrFacts, maxAgeMs: number): boolean {
    if (f.state === "merged") return true;
    if (f.state === "closed" && maxAgeMs > 0) return true; // a closed PR can be reopened: a forced read checks again
    return maxAgeMs > 0 && this.now() - f.checkedAt < maxAgeMs;
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    // A finished call hands its slot straight to the next waiter, so a newcomer cannot slip in between.
    if (this.running >= this.concurrency) await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.running += 1;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
