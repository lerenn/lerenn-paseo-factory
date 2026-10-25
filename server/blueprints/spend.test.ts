import { describe, expect, it } from "vitest";
import { aggregate, SpendStore, type SpendRecord } from "./spend";

const rec = (over: Partial<SpendRecord>): SpendRecord => ({ agentId: "a", turnId: "t", at: Date.UTC(2026, 9, 25, 10), role: "implementer", run: "bp-1", blueprint: "ticket", stage: "implement", inputTokens: 100, cachedInputTokens: 10, outputTokens: 50, costUsd: 0.5, ...over });

describe("spend", () => {
  it("records each turn once", () => {
    const s = new SpendStore(null);
    expect(s.add(rec({}))).toBe(true);
    expect(s.add(rec({}))).toBe(false);
    expect(s.add(rec({ turnId: "t2" }))).toBe(true);
    expect(s.all()).toHaveLength(2);
  });

  it("aggregates per run, role and day, most expensive first", () => {
    const r = aggregate([
      rec({ turnId: "1" }),
      rec({ turnId: "2", costUsd: 1.5, run: "bp-2" }),
      rec({ turnId: "3", role: "qa", stage: "qa", at: Date.UTC(2026, 9, 24, 9), costUsd: 0.25 }),
    ]);
    expect(r.total).toMatchObject({ turns: 3, costUsd: 2.25, inputTokens: 300, outputTokens: 150 });
    expect(r.byRun.map((x) => [x.key, x.costUsd])).toEqual([["bp-2", 1.5], ["bp-1", 0.75]]);
    expect(r.byRole.map((x) => x.key)).toEqual(["implementer", "qa"]);
    expect(r.byDay.map((x) => x.key)).toEqual(["2026-10-25", "2026-10-24"]);
    expect(aggregate([rec({ turnId: "1" })], Date.UTC(2026, 9, 26)).total.turns).toBe(0);
  });
});
