import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrFacts } from "./engine";

// The fallback is the Factory's own `gh` reads: record every `gh` call instead of running it.
const gh = vi.hoisted(() => ({ calls: [] as string[][], answer: (_args: string[]): string => "{}" }));
vi.mock("node:child_process", () => ({
  execFile: (cmd: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    gh.calls.push([cmd, ...args]);
    try {
      cb(null, gh.answer(args), "");
    } catch (e) {
      cb(e as Error, "", (e as Error).message);
    }
  },
}));

const { factsProvider, factsSource, PR_FACTS_PROVIDER_KEY } = await import("./facts-provider");
const { ghDiff, ghFacts, isGitHubPrUrl } = await import("./github");

const g = globalThis as Record<symbol, unknown>;
const PR = "https://github.com/acme/api/pull/7";
const fromGitHub = () => factsSource({ prFacts: ghFacts, prDiff: ghDiff, matches: isGitHubPrUrl });
const facts = (over: Partial<PrFacts> = {}): PrFacts => ({ url: PR, exists: true, state: "open", head: "p1", ci: "green", mergeable: true, draft: false, review: "", queued: true, queuePosition: 2, ...over });

/** What `gh` answers for a queued, green PR (the same facts as `facts()`, read the fallback's way). */
function ghAnswers(args: string[]): string {
  if (args[0] === "pr" && args.includes("changedFiles,additions,deletions")) return JSON.stringify({ changedFiles: 3, additions: 10, deletions: 2 });
  if (args[0] === "pr") return JSON.stringify({ state: "OPEN", headRefOid: "p1", mergeable: "MERGEABLE", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], reviewDecision: "", isDraft: false, autoMergeRequest: null });
  if (args[0] === "api" && args[1] === "graphql") return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: true, mergeQueueEntry: { position: 2, estimatedTimeToMerge: null } } } } });
  throw new Error(`unexpected gh ${args.join(" ")}`);
}

beforeEach(() => {
  gh.calls = [];
  gh.answer = ghAnswers;
});
afterEach(() => {
  delete g[PR_FACTS_PROVIDER_KEY];
});

describe("PR facts without a provider (the lab before paseo-factory-github)", () => {
  it("reads GitHub through gh exactly as before: pr view, then the merge-queue graphql", async () => {
    const f = await fromGitHub().prFacts(PR);
    expect(f).toEqual({ url: PR, exists: true, state: "open", head: "p1", ci: "green", mergeable: true, draft: false, review: "", queued: true, queuePosition: 2 });
    expect(gh.calls.map((c) => c.slice(0, 3))).toEqual([["gh", "pr", "view"], ["gh", "api", "graphql"]]);
  });

  it("the diff and the URL check are gh's too", async () => {
    expect(await fromGitHub().prDiff(PR)).toEqual({ files: 3, additions: 10, deletions: 2 });
    expect(fromGitHub().isPrUrl(PR)).toBe(true);
    expect(fromGitHub().isPrUrl("https://gitlab.com/acme/api/-/merge_requests/7")).toBe(false);
  });

  it("an empty registry, or one whose providers do not take the URL, is the same as none", async () => {
    g[PR_FACTS_PROVIDER_KEY] = { other: { matches: () => false, prFacts: async () => facts({ head: "never" }) } };
    expect((await fromGitHub().prFacts(PR)).head).toBe("p1");
    expect(gh.calls.length).toBeGreaterThan(0);
  });
});

describe("PR facts with a provider", () => {
  it("reads through the provider, never gh", async () => {
    const seen: string[] = [];
    g[PR_FACTS_PROVIDER_KEY] = {
      github: {
        matches: isGitHubPrUrl,
        prFacts: async (url: string) => (seen.push(url), facts({ head: "from-provider" })),
        prDiff: async () => ({ files: 1, additions: 1, deletions: 0 }),
      },
    };
    const src = fromGitHub();
    expect(await src.prFacts(PR)).toMatchObject({ head: "from-provider", queued: true, queuePosition: 2 });
    expect(await src.prDiff(PR)).toEqual({ files: 1, additions: 1, deletions: 0 });
    expect(seen).toEqual([PR]);
    expect(gh.calls).toEqual([]);
  });

  it("a provider without prDiff leaves the diff to the fallback", async () => {
    g[PR_FACTS_PROVIDER_KEY] = { github: { matches: isGitHubPrUrl, prFacts: async () => facts() } };
    expect(await fromGitHub().prDiff(PR)).toEqual({ files: 3, additions: 10, deletions: 2 });
  });

  it("takes the URLs it matches, even ones the fallback does not", async () => {
    const MR = "https://forge.example/acme/api/merge/7";
    g[PR_FACTS_PROVIDER_KEY] = { forge: { matches: (u: string) => u.startsWith("https://forge.example/"), prFacts: async () => facts({ url: "ignored" }) } };
    expect(fromGitHub().isPrUrl(MR)).toBe(true);
    expect(await fromGitHub().prFacts(MR)).toMatchObject({ url: MR, head: "p1" });
    expect(factsProvider(PR)).toBeNull();
  });

  it("a provider failure is the answer: it errors, and gh is not tried behind it", async () => {
    g[PR_FACTS_PROVIDER_KEY] = { github: { matches: isGitHubPrUrl, prFacts: async () => { throw new Error("rate limited"); } } };
    await expect(fromGitHub().prFacts(PR)).rejects.toThrow("rate limited");
    expect(gh.calls).toEqual([]);
  });

  it("malformed facts are an error, not a guess", async () => {
    g[PR_FACTS_PROVIDER_KEY] = { github: { matches: isGitHubPrUrl, prFacts: async () => ({ ...facts(), state: "MERGED" }) } };
    await expect(fromGitHub().prFacts(PR)).rejects.toThrow("malformed");
  });

  it("is looked up on every read: registering or removing it later takes effect at once", async () => {
    const src = fromGitHub();
    expect((await src.prFacts(PR)).head).toBe("p1");
    g[PR_FACTS_PROVIDER_KEY] = { github: { matches: isGitHubPrUrl, prFacts: async () => facts({ head: "p2" }) } };
    expect((await src.prFacts(PR)).head).toBe("p2");
    delete g[PR_FACTS_PROVIDER_KEY];
    expect((await src.prFacts(PR)).head).toBe("p1");
  });
});
