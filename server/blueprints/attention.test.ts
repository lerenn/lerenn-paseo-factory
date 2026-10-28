import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AttentionNotifier, attentionPoints, STALLED_MS } from "./attention";
import type { Run } from "./store";

const now = 10_000_000_000;
const run = (over: Partial<Run>): Run =>
  ({ id: "bp-1", blueprint: "ticket", vars: { ticket: "ANY-1" }, status: "running", stage: "implement", updatedAt: now, endedAt: null, error: null, waitingFor: null, pm: { judged: {}, pending: null }, history: [], stages: {}, ...over }) as Run;

describe("attentionPoints", () => {
  it("lists paused, PM-pending, stalled and recently failed runs, and pending items", () => {
    const keys = attentionPoints(
      [
        run({ id: "a", status: "paused" }),
        run({ id: "b", status: "waiting", pm: { judged: {}, pending: { stage: "qa", reason: "exhausted" } } }),
        run({ id: "c", updatedAt: now - STALLED_MS - 1 }),
        run({ id: "d", status: "failed", endedAt: now - 1000 }),
        run({ id: "e" }),
      ],
      [{ id: "item-1", agentId: "x", question: "Merge?", createdAt: now }],
      now,
    ).map((p) => p.key);
    expect(keys).toEqual(["run:a:paused:implement", "run:b:pm:implement", "run:c:stalled:implement", "run:d:failed:implement", "inbox:item-1"]);
  });

  it("leaves out suspended runs, old failures and paused runs whose escalation is an Inbox item", () => {
    expect(
      attentionPoints(
        [
          run({ id: "s", status: "suspended", suspended: { reason: "waiting for review", at: now, by: "x", prevStatus: "paused", pods: [] } }),
          run({ id: "f", status: "failed", endedAt: now - 2 * 24 * 3600_000 }),
          run({ id: "p", status: "paused", escalations: { "item-2": { stage: "implement", kind: "setup" } } }),
        ],
        [],
        now,
      ),
    ).toEqual([]);
  });
});

describe("AttentionNotifier", () => {
  it("records silently the first time, then mails each new point once, and again after it went away", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "att-")), "attention.json");
    const mailed: string[] = [];
    const n = new AttentionNotifier(file, async (p) => void mailed.push(p.key));
    const p = (key: string) => ({ key, subject: key, body: key });
    await n.tick([p("old")]);
    expect(mailed).toEqual([]);
    await n.tick([p("old"), p("new")]);
    await n.tick([p("old"), p("new")]);
    expect(mailed).toEqual(["new"]);
    await n.tick([p("old")]);
    await n.tick([p("old"), p("new")]);
    expect(mailed).toEqual(["new", "new"]);
    const again = new AttentionNotifier(file, async (q) => void mailed.push(q.key));
    await again.tick([p("old"), p("new")]);
    expect(mailed).toEqual(["new", "new"]);
  });
});
