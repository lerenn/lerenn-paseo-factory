import { describe, expect, it } from "vitest";
import { prUrlsOf, runSnapshot } from "./snapshot";
import type { CachedPrFacts } from "./pr-facts-cache";

const stage = (over: object = {}) => ({ status: "pending", runs: 0, attempts: 0, extra: 0, flakes: 0, agentId: null, wardenTask: null, verdict: null, summary: null, data: {}, notes: [], gate: null, childRunId: null, startedAt: null, endedAt: null, lastNudgeAt: null, ...over });
const A = "https://github.com/o/r/pull/1";
const B = "https://github.com/o/r/pull/2";

function run(over: object = {}): any {
  return {
    id: "bp-1",
    blueprint: "ticket",
    status: "waiting",
    stage: "review",
    vars: { ticket: "ANY-1" },
    parent: null,
    updatedAt: 5,
    endedAt: null,
    waitingFor: "a person: approve",
    pm: { judged: {}, pending: null },
    history: [{ at: 1, stage: null, event: "started", detail: null }, { at: 2, stage: "implement", event: "spawned", detail: null }, { at: 3, stage: "implement", event: "spawned", detail: null }],
    escalations: { "item-9": { stage: "implement", kind: "stuck" } },
    suspended: null,
    def: { stage: [{ id: "implement", kind: "agent", role: "implementer" }, { id: "review", kind: "gate", question: "Merge?" }, { id: "merge", kind: "gate", wait: "merge" }] },
    stages: {
      implement: stage({ status: "done", agentId: "ag-1", verdict: "done", data: { pr_urls: [A] } }),
      review: stage({ status: "waiting", gate: { itemId: "item-1", heads: { [A]: "abc", [B]: "def" }, criteriaSha: null, reused: false, openedAt: 4 } }),
    },
    ...over,
  };
}

describe("run snapshot", () => {
  it("lists every PR a run refers to", () => {
    expect(prUrlsOf(run()).sort()).toEqual([A, B]);
  });

  it("carries the current stage, the open gate, escalations and the last PR facts", () => {
    const seen: CachedPrFacts = { url: A, exists: true, state: "open", head: "abc", ci: "green", mergeable: true, draft: false, review: "APPROVED", checkedAt: 42 };
    const snap = runSnapshot(run(), (url) => (url === A ? seen : undefined));
    expect(snap).toMatchObject({
      stage: "review",
      waitingFor: "a person: approve",
      pmPending: null,
      suspended: null,
      gate: { stage: "review", itemId: "item-1", kind: "approval", openedAt: 4, passive: false },
      escalations: ["item-9"],
      agentId: null,
      role: null,
      events: ["started", "spawned"],
      stages: { implement: { status: "done", verdict: "done", summary: null, data: { pr_urls: [A] } } },
    });
    expect(snap.prs).toEqual({ [A]: { exists: true, state: "open", head: "abc", ci: "green", mergeable: true, draft: false, review: "APPROVED", checkedAt: 42 } });
  });

  it("shows a passive merge wait without an item, and the worker of an agent stage", () => {
    const merge = run({ stage: "merge", stages: { merge: stage({ status: "waiting", gate: { itemId: "", heads: { [A]: "abc" }, criteriaSha: null, reused: false, passive: true } }) } });
    expect(runSnapshot(merge, () => undefined).gate).toEqual({ stage: "merge", itemId: null, kind: "merge", openedAt: null, passive: true });
    const working = run({ status: "running", stage: "implement", stages: { implement: stage({ status: "running", agentId: "ag-2" }) }, pm: { judged: {}, pending: { stage: "implement", reason: "exhausted" } }, suspended: { reason: "quota", at: 7, by: "louis", prevStatus: "running", pods: [] } });
    expect(runSnapshot(working, () => undefined)).toMatchObject({ gate: null, agentId: "ag-2", role: "implementer", pmPending: { stage: "implement", reason: "exhausted" }, suspended: { reason: "quota", since: 7, by: "louis" } });
  });
});
