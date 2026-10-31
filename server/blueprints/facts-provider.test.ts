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

const { factsSource, PR_FACTS_RPC, PR_DIFF_RPC } = await import("./facts-provider");
const { ghDiff, ghFacts, isGitHubPrUrl } = await import("./github");
type FactsRpc = import("./facts-provider").FactsRpc;

const PR = "https://github.com/acme/api/pull/7";
const logs: string[] = [];
const fromGitHub = (rpc?: FactsRpc, timeoutMs?: number) => factsSource({ prFacts: ghFacts, prDiff: ghDiff, matches: isGitHubPrUrl }, rpc, { timeoutMs, log: (m) => logs.push(m) });
const facts = (over: Partial<PrFacts> = {}): PrFacts => ({ url: PR, exists: true, state: "open", head: "p1", ci: "green", mergeable: true, draft: false, review: "", queued: true, queuePosition: 2, ...over });
/** An extension offering `pr_facts` and `pr_diff` with these answers; `calls` records each rpc call. */
function provider(answers: { facts?: () => unknown; diff?: () => unknown }) {
  const calls: [string, unknown][] = [];
  const rpc: FactsRpc = (name, input) => {
    const answer = name === PR_FACTS_RPC ? answers.facts : name === PR_DIFF_RPC ? answers.diff : undefined;
    if (!answer) return null;
    calls.push([name, input]);
    return Promise.resolve().then(answer);
  };
  return { rpc, calls };
}

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
  logs.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("PR facts without a provider extension", () => {
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

  it("an rpc lookup that finds no extension is the same as none", async () => {
    expect((await fromGitHub(() => null).prFacts(PR)).head).toBe("p1");
    expect(gh.calls.length).toBeGreaterThan(0);
    expect(logs).toEqual([]);
  });
});

describe("PR facts through the pr_facts rpc", () => {
  it("reads through the rpc, never gh", async () => {
    const p = provider({ facts: () => facts({ head: "from-provider", url: "ignored" }), diff: () => ({ files: 1, additions: 1, deletions: 0 }) });
    const src = fromGitHub(p.rpc);
    expect(await src.prFacts(PR)).toMatchObject({ url: PR, head: "from-provider", queued: true, queuePosition: 2 });
    expect(await src.prDiff(PR)).toEqual({ files: 1, additions: 1, deletions: 0 });
    expect(p.calls).toEqual([[PR_FACTS_RPC, { url: PR }], [PR_DIFF_RPC, { url: PR }]]);
    expect(gh.calls).toEqual([]);
  });

  it("a null answer (a URL the provider does not read) falls back to gh", async () => {
    const p = provider({ facts: () => null, diff: () => null });
    expect((await fromGitHub(p.rpc).prFacts(PR)).head).toBe("p1");
    expect(await fromGitHub(p.rpc).prDiff(PR)).toEqual({ files: 3, additions: 10, deletions: 2 });
    expect(p.calls).toHaveLength(2);
    expect(gh.calls.length).toBeGreaterThan(0);
    expect(logs).toEqual([]);
  });

  it("an extension without pr_diff leaves the diff to gh", async () => {
    const p = provider({ facts: () => facts() });
    expect(await fromGitHub(p.rpc).prDiff(PR)).toEqual({ files: 3, additions: 10, deletions: 2 });
  });

  it("an rpc error falls back to gh, logged once per streak", async () => {
    let fail = true;
    const p = provider({ facts: () => { if (fail) throw new Error("extension unreachable: ECONNREFUSED"); return facts({ head: "p9" }); } });
    const src = fromGitHub(p.rpc);
    expect((await src.prFacts(PR)).head).toBe("p1");
    expect((await src.prFacts(PR)).head).toBe("p1");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("ECONNREFUSED");
    fail = false;
    expect((await src.prFacts(PR)).head).toBe("p9");
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain("answers again");
  });

  it("an rpc that throws synchronously falls back to gh", async () => {
    const src = fromGitHub(() => { throw new Error("boom"); });
    expect((await src.prFacts(PR)).head).toBe("p1");
  });

  it("an rpc that does not answer in time falls back to gh", async () => {
    vi.useFakeTimers();
    const src = fromGitHub(() => new Promise(() => {}), 1000);
    const read = src.prFacts(PR);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await read).head).toBe("p1");
    expect(logs[0]).toContain("no answer in 1 s");
  });

  it("malformed facts or diff fall back to gh, never a guess", async () => {
    const p = provider({ facts: () => ({ ...facts(), state: "MERGED" }), diff: () => ({ files: "3" }) });
    expect((await fromGitHub(p.rpc).prFacts(PR)).state).toBe("open");
    expect(await fromGitHub(p.rpc).prDiff(PR)).toEqual({ files: 3, additions: 10, deletions: 2 });
    expect(logs[0]).toContain("malformed");
  });

  it("is looked up on every read: an extension registering or leaving later takes effect at once", async () => {
    let registered = false;
    const p = provider({ facts: () => facts({ head: "p2" }) });
    const src = fromGitHub((name, input) => (registered ? p.rpc(name, input) : null));
    expect((await src.prFacts(PR)).head).toBe("p1");
    registered = true;
    expect((await src.prFacts(PR)).head).toBe("p2");
    registered = false;
    expect((await src.prFacts(PR)).head).toBe("p1");
  });
});
