import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aggregate, SpendStore, type SpendRecord, type SpendSample } from "./spend";
import { cli, normalizeSpend, recomputeSpendFile, spendRole, releaseRoleOfTitle } from "./spend-recompute";

const rec = (over: Partial<SpendRecord>): SpendRecord => ({ agentId: "a", turnId: "t", at: Date.UTC(2026, 9, 25, 10), role: "implementer", run: "bp-1", blueprint: "ticket", stage: "implement", inputTokens: 100, cachedInputTokens: 10, outputTokens: 50, costUsd: 0.5, ...over });
const sample = (over: Partial<SpendSample>): SpendSample => {
  const { costUsd: _, costTotalUsd, ...r } = rec({});
  return { ...r, costTotalUsd: costTotalUsd ?? 0.5, ...over };
};
const costs = (rs: readonly SpendRecord[]) => rs.map((r) => r.costUsd);
const tmp = () => mkdtempSync(path.join(tmpdir(), "spend-"));

describe("spend", () => {
  it("records each turn once", () => {
    const s = new SpendStore(null);
    expect(s.add(sample({}))).toBe(true);
    expect(s.add(sample({}))).toBe(false);
    expect(s.add(sample({ turnId: "t2", costTotalUsd: 0.7 }))).toBe(true);
    expect(s.all()).toHaveLength(2);
  });

  it("records the turn's share of the session's running total", () => {
    const s = new SpendStore(null);
    s.add(sample({ turnId: "1", costTotalUsd: 0.58 }));
    s.add(sample({ turnId: "2", costTotalUsd: 0.9, inputTokens: 7 }));
    s.add(sample({ turnId: "3", costTotalUsd: 1.92, inputTokens: 9 }));
    // Another agent's session is its own.
    s.add(sample({ agentId: "b", turnId: "1", costTotalUsd: 0.25 }));
    expect(costs(s.all())).toEqual([0.58, 0.32, 1.02, 0.25]);
    expect(s.all()[2]).toMatchObject({ costTotalUsd: 1.92, inputTokens: 9 });
    expect(aggregate(s.all()).total).toMatchObject({ turns: 4, costUsd: 2.17, inputTokens: 216 });
  });

  it("counts a value below the previous one whole: a new session", () => {
    const s = new SpendStore(null);
    s.add(sample({ turnId: "1", costTotalUsd: 1.5 }));
    s.add(sample({ turnId: "2", costTotalUsd: 0.2, inputTokens: 1 }));
    s.add(sample({ turnId: "3", costTotalUsd: 0.5, inputTokens: 2 }));
    expect(costs(s.all())).toEqual([1.5, 0.2, 0.3]);
  });

  it("drops the same usage read again under another turn id", () => {
    const s = new SpendStore(null);
    expect(s.add(sample({ turnId: "1", costTotalUsd: 0.4 }))).toBe(true);
    expect(s.add(sample({ turnId: "875bc864", costTotalUsd: 0.4 }))).toBe(false);
    // Same cost, other tokens: a turn that cost nothing more is still a turn.
    expect(s.add(sample({ turnId: "2", costTotalUsd: 0.4, outputTokens: 1 }))).toBe(true);
    expect(costs(s.all())).toEqual([0.4, 0]);
  });

  it("reads old records (running totals in costUsd) and new ones from the same file", () => {
    const dir = tmp();
    const file = path.join(dir, "spend.json");
    const old = [rec({ turnId: "1", costUsd: 0.58 }), rec({ turnId: "2", costUsd: 0.9, inputTokens: 1 }), rec({ turnId: "dup", costUsd: 0.9, inputTokens: 1 })];
    writeFileSync(file, JSON.stringify({ records: old }));
    const s = new SpendStore(file);
    expect(costs(s.all())).toEqual([0.58, 0.32]);
    // A new turn continues from the old records' running total, and is saved in the new shape.
    s.add(sample({ turnId: "3", costTotalUsd: 1.92, inputTokens: 2 }));
    expect(costs(s.all())).toEqual([0.58, 0.32, 1.02]);
    const saved = JSON.parse(readFileSync(file, "utf8")).records as SpendRecord[];
    expect(saved.map((r) => [r.costUsd, r.costTotalUsd])).toEqual([[0.58, 0.58], [0.32, 0.9], [1.02, 1.92]]);
    expect(costs(new SpendStore(file).all())).toEqual([0.58, 0.32, 1.02]);
  });

  it("normalizes idempotently", () => {
    const once = normalizeSpend([rec({ turnId: "1", costUsd: 1 }), rec({ turnId: "2", costUsd: 1 }), rec({ turnId: "3", costUsd: 3, outputTokens: 1 }), rec({ turnId: "4", costUsd: 0.5, outputTokens: 2 })]);
    expect(costs(once.records)).toEqual([1, 2, 0.5]);
    expect(once.dropped).toBe(1);
    const twice = normalizeSpend(once.records);
    expect(twice.records).toEqual(once.records);
    expect(twice.dropped).toBe(0);
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

describe("release roles", () => {
  it("names release agents by their releaser label and title", () => {
    expect(spendRole({ "releaser.qa": "12" }, "Dev QA: backend v1.2.3")).toBe("Dev QA");
    expect(spendRole({ "releaser.job": "job-1a2b" }, "Release: cut")).toBe("Release cut");
    expect(spendRole({ "releaser.job": "job-1a2b" }, "Release: pin dev")).toBe("Pin dev");
    expect(spendRole({ "releaser.job": "job-1a2b" }, "Release: pin stg")).toBe("Pin stg");
    expect(spendRole({ "releaser.job": "job-1a2b" }, "Release: pin prd")).toBe("Pin prd");
    expect(spendRole({ "releaser.job": "job-1a2b" }, "Release: migration")).toBe("Release migration");
    expect(spendRole({ "releaser.job": "job-1a2b" }, "something else")).toBe("Release");
    expect(spendRole({}, "Release: cut")).toBeNull();
    expect(releaseRoleOfTitle("ticket · implement · ANY-1")).toBeNull();
    expect(releaseRoleOfTitle(null)).toBeNull();
  });
});

describe("spend recompute", () => {
  const NOW = Date.UTC(2026, 9, 30, 12);
  const day = (d: number) => Date.UTC(2026, 9, d, 10);
  const setup = () => {
    const dir = tmp();
    const file = path.join(dir, "spend.json");
    const warden = path.join(dir, "warden.json");
    const records = [
      rec({ agentId: "c5159d4b", turnId: "1", run: "bp-350bbaa7", at: day(28), costUsd: 0.58 }),
      rec({ agentId: "c5159d4b", turnId: "2", run: "bp-350bbaa7", at: day(28), costUsd: 1.2, inputTokens: 1 }),
      rec({ agentId: "c5159d4b", turnId: "875bc864", run: "bp-350bbaa7", at: day(28), costUsd: 1.2, inputTokens: 1 }),
      rec({ agentId: "c5159d4b", turnId: "3", run: "bp-350bbaa7", at: day(29), costUsd: 1.92, inputTokens: 2 }),
      rec({ agentId: "rel", turnId: "1", role: null, run: null, at: day(29), costUsd: 0.1 }),
      rec({ agentId: "qa", turnId: "1", role: null, run: null, at: day(29), costUsd: 0.2 }),
      rec({ agentId: "old", turnId: "1", at: Date.UTC(2026, 8, 1), costUsd: 5 }),
    ];
    writeFileSync(file, JSON.stringify({ records }));
    writeFileSync(warden, JSON.stringify({ agents: { rel: { title: "Release: pin stg" }, qa: { title: "Dev QA: backend v1" }, c5159d4b: { title: "Release: cut" } } }));
    return { dir, file, warden, text: JSON.stringify({ records }) };
  };

  it("backs up, rewrites with per-turn costs and release roles, and reports before and after", () => {
    const { dir, file, warden, text } = setup();
    const r = recomputeSpendFile(file, { wardenFile: warden, runs: ["bp-350bbaa7"], now: NOW });
    expect(readFileSync(r.backup, "utf8")).toBe(text);
    expect(r.records).toEqual({ before: 7, after: 6, duplicates: 1, relabelled: 2 });
    expect(r.window).toEqual({ days: 30, before: 5.2, after: 2.22 });
    expect(r.runs).toEqual([{ run: "bp-350bbaa7", before: 4.9, after: 1.92 }]);
    const saved = JSON.parse(readFileSync(file, "utf8")).records as SpendRecord[];
    expect(saved.map((x) => [x.agentId, x.role, x.costUsd])).toEqual([
      ["c5159d4b", "implementer", 0.58],
      ["c5159d4b", "implementer", 0.62],
      ["c5159d4b", "implementer", 0.72],
      ["rel", "Pin stg", 0.1],
      ["qa", "Dev QA", 0.2],
      ["old", "implementer", 5],
    ]);
    expect(readdirSync(dir).filter((f) => f.includes(".bak-"))).toHaveLength(1);
  });

  it("is idempotent and never touches an existing backup", () => {
    const { file, warden } = setup();
    const first = recomputeSpendFile(file, { wardenFile: warden, now: NOW });
    const after = readFileSync(file, "utf8");
    const backup = readFileSync(first.backup, "utf8");
    const second = recomputeSpendFile(file, { wardenFile: warden, now: NOW + 1000 });
    expect(second.changed).toBe(false);
    expect(second.window.before).toBe(second.window.after);
    expect(readFileSync(file, "utf8")).toBe(after);
    expect(readFileSync(first.backup, "utf8")).toBe(backup);
    // Same timestamp: refused rather than overwriting the backup.
    expect(() => recomputeSpendFile(file, { wardenFile: warden, now: NOW })).toThrow();
    expect(readFileSync(first.backup, "utf8")).toBe(backup);
  });

  it("runs as a CLI, reading warden.json next to spend.json by default", () => {
    const { file } = setup();
    const out = cli([file, "--run", "bp-350bbaa7", "--now", String(NOW)]);
    expect(out).toContain("30-day total: $5.20 -> $2.22");
    expect(out).toContain("run bp-350bbaa7: $4.90 -> $1.92");
    expect(out).toContain("2 release agents given a role");
  });
});
