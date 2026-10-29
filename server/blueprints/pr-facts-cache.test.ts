import { describe, expect, it } from "vitest";
import type { PrFacts } from "./engine";
import { PrFactsCache } from "./pr-facts-cache";

const facts = (url: string, state: PrFacts["state"] = "open", head = "abc"): PrFacts => ({ url, exists: true, state, head, ci: "green", mergeable: true, draft: false, review: "" });

function setup(state: (url: string) => PrFacts["state"] = () => "open") {
  let now = 1_000_000;
  const calls: string[] = [];
  const release: (() => void)[] = [];
  let gated = false;
  const cache = new PrFactsCache({
    now: () => now,
    fetch: async (url) => {
      calls.push(url);
      if (gated) await new Promise<void>((r) => release.push(r));
      return facts(url, state(url), `h${calls.length}`);
    },
  });
  return { cache, calls, release, gate: (on: boolean) => (gated = on), advance: (ms: number) => (now += ms), now: () => now };
}

const U = "https://github.com/o/r/pull/1";

describe("PrFactsCache", () => {
  it("serves a fact younger than 2 min from memory, with checkedAt, and reads again after", async () => {
    const t = setup();
    const first = await t.cache.get(U);
    expect(first).toMatchObject({ url: U, head: "h1", checkedAt: t.now() });
    t.advance(119_000);
    expect((await t.cache.get(U)).head).toBe("h1");
    t.advance(2_000);
    expect((await t.cache.get(U)).head).toBe("h2");
    expect(t.calls).toHaveLength(2);
  });

  it("reads GitHub now with maxAgeMs 0", async () => {
    const t = setup();
    await t.cache.get(U);
    expect((await t.cache.get(U, { maxAgeMs: 0 })).head).toBe("h2");
  });

  it("keeps a merged PR for good and a closed one until a forced read", async () => {
    const merged = setup(() => "merged");
    await merged.cache.get(U);
    merged.advance(24 * 3600_000);
    await merged.cache.get(U);
    await merged.cache.get(U, { maxAgeMs: 0 });
    expect(merged.calls).toHaveLength(1);
    const closed = setup(() => "closed");
    await closed.cache.get(U);
    closed.advance(24 * 3600_000);
    await closed.cache.get(U);
    expect(closed.calls).toHaveLength(1);
    await closed.cache.get(U, { maxAgeMs: 0 });
    expect(closed.calls).toHaveLength(2);
  });

  it("shares one lookup between concurrent callers of a URL", async () => {
    const t = setup();
    t.gate(true);
    const all = Promise.all([t.cache.get(U), t.cache.get(U), t.cache.get(U, { maxAgeMs: 0 })]);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.calls).toHaveLength(1);
    t.release.splice(0).forEach((r) => r());
    expect(new Set((await all).map((f) => f.head))).toEqual(new Set(["h1"]));
  });

  it("runs at most 4 lookups at once", async () => {
    const t = setup();
    t.gate(true);
    const urls = Array.from({ length: 7 }, (_, i) => `https://github.com/o/r/pull/${i + 1}`);
    const all = Promise.all(urls.map((u) => t.cache.get(u)));
    await new Promise((r) => setTimeout(r, 0));
    expect(t.calls).toHaveLength(4);
    t.release.splice(0, 1).forEach((r) => r());
    await new Promise((r) => setTimeout(r, 0));
    expect(t.calls).toHaveLength(5);
    // drain
    while (t.calls.length < 7 || t.release.length) {
      t.release.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(await all).toHaveLength(7);
  });

  it("does not cache a failure, peeks without a lookup and prunes PRs no run refers to", async () => {
    let fail = true;
    const cache = new PrFactsCache({ fetch: async (url) => (fail ? Promise.reject(new Error("gh down")) : facts(url)) });
    await expect(cache.get(U)).rejects.toThrow("gh down");
    expect(cache.peek(U)).toBeUndefined();
    fail = false;
    await cache.get(U);
    expect(cache.peek(U)?.url).toBe(U);
    cache.prune(new Set(["https://github.com/o/r/pull/2"]));
    expect(cache.size).toBe(0);
  });
});
