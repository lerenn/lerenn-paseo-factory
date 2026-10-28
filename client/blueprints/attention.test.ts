import { describe, expect, it } from "vitest";
import type { RunView } from "../../shared/blueprints/run";
import { needsAttention, needsAttentionBadge } from "./attention";

const run = (over: Partial<RunView>): RunView => ({ status: "running", pmPending: null, escalations: [], ...over }) as RunView;

describe("run attention", () => {
  it("counts a paused run without an escalation item", () => {
    expect(needsAttentionBadge(run({ status: "paused" }))).toBe(true);
  });
  it("leaves a paused run whose escalation is an inbox item to the inbox count", () => {
    const r = run({ status: "paused", escalations: ["2dd6cfae"] });
    expect(needsAttention(r)).toBe(true);
    expect(needsAttentionBadge(r)).toBe(false);
  });
  it("ignores a suspended run, even with a PM judgement pending", () => {
    expect(needsAttention(run({ status: "suspended", pmPending: { stage: "qa", reason: "x" } }))).toBe(false);
  });
  it("ignores a running run", () => {
    expect(needsAttentionBadge(run({}))).toBe(false);
  });
});
