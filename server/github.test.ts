import { beforeEach, describe, expect, it, vi } from "vitest";

// Record every `gh` call and answer it from a script instead of running it.
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

const { ghDiff, ghFacts, rollup } = await import("./github");
const PR = "https://github.com/acme/api/pull/7";

type View = Record<string, unknown>;
function answers(view: View, queue: unknown = { isInMergeQueue: false, mergeQueueEntry: null }) {
  return (args: string[]): string => {
    if (args[0] === "pr" && args.includes("changedFiles,additions,deletions")) return JSON.stringify({ changedFiles: 3, additions: 10, deletions: 2 });
    if (args[0] === "pr") return JSON.stringify(view);
    if (args[0] === "api" && args[1] === "graphql") return JSON.stringify({ data: { repository: { pullRequest: queue } } });
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
}
const open: View = { state: "OPEN", headRefOid: "h1", mergeable: "MERGEABLE", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], reviewDecision: "APPROVED", isDraft: false, autoMergeRequest: null };

beforeEach(() => {
  gh.calls = [];
});

describe("ghFacts (the reads moved from the Factory)", () => {
  it("an open PR in the merge queue: position and ETA", async () => {
    gh.answer = answers(open, { isInMergeQueue: true, mergeQueueEntry: { position: 2, estimatedTimeToMerge: 300 } });
    expect(await ghFacts(PR)).toEqual({ url: PR, exists: true, state: "open", head: "h1", ci: "green", mergeable: true, draft: false, review: "APPROVED", queued: true, queuePosition: 2, queueEtaSeconds: 300 });
  });

  it("auto-merge on counts as queued even when GitHub drops it from the queue answer", async () => {
    gh.answer = answers({ ...open, autoMergeRequest: { enabledAt: "x" } }, { isInMergeQueue: false, mergeQueueEntry: null });
    expect((await ghFacts(PR)).queued).toBe(true);
  });

  it("out of the queue with auto-merge off: queued false (the Factory's left-queue notice reads this)", async () => {
    gh.answer = answers(open);
    expect((await ghFacts(PR)).queued).toBe(false);
  });

  it("a merged PR is never asked about the queue", async () => {
    gh.answer = answers({ ...open, state: "MERGED" });
    expect(await ghFacts(PR)).toMatchObject({ state: "merged", queued: false });
    expect(gh.calls.some((c) => c[2] === "graphql")).toBe(false);
  });

  it("a PR that does not exist is exists: false, not an error", async () => {
    gh.answer = () => {
      throw new Error("GraphQL: Could not resolve to a PullRequest");
    };
    expect(await ghFacts(PR)).toMatchObject({ exists: false, state: "closed" });
  });

  it("without the Checks API (403) CI comes from statuses and the latest run of each workflow", async () => {
    gh.answer = (args) => {
      if (args[0] === "pr" && args.includes("state,headRefOid,mergeable,statusCheckRollup,reviewDecision,isDraft,autoMergeRequest")) throw new Error("HTTP 403: Resource not accessible by integration");
      if (args[0] === "pr") return JSON.stringify({ ...open, statusCheckRollup: undefined });
      if (args[1]?.endsWith("/status")) return JSON.stringify({ statuses: [{ state: "success" }] });
      if (args[1]?.includes("actions/runs")) return JSON.stringify({ workflow_runs: [{ id: 1, workflow_id: 9, status: "completed", conclusion: "failure" }, { id: 2, workflow_id: 9, status: "completed", conclusion: "success" }] });
      return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false } } } });
    };
    expect((await ghFacts(PR)).ci).toBe("green");
  });

  it("refuses a URL that is not a GitHub PR", async () => {
    await expect(ghFacts("https://github.com/acme/api/issues/7")).rejects.toThrow("not a GitHub pull request URL");
  });

  it("the diff summary", async () => {
    gh.answer = answers(open);
    expect(await ghDiff(PR)).toEqual({ files: 3, additions: 10, deletions: 2 });
  });

  it("rollup: red wins, then pending, else green; nothing is none", () => {
    expect(rollup([])).toBe("none");
    expect(rollup([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }])).toBe("red");
    expect(rollup([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])).toBe("pending");
    expect(rollup([{ conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe("green");
  });
});
