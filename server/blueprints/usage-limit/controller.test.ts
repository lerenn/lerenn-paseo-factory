import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { UsageLimitSettings } from "../../../shared/blueprints/settings";
import type { Run, UsageLimitHold } from "../store";
import { CONFIRM_PROBE_DELAY_MS, UsageLimitFile, UsageLimits, type ControllerPorts } from "./controller";

const SETTINGS: UsageLimitSettings = { enabled: true, notify: ["@assistant"], unknownAlertTo: "@user", confirmMinutes: 15, probeMinutes: 5, probeModel: "", resumeConcurrency: 2, resumeStaggerSeconds: 60, resetZone: "UTC" };
const LIMIT = "Claude AI usage limit reached";

function run(id: string, status: Run["status"] = "running"): Run {
  return { id, blueprint: "flow", status, stage: "work", stages: { work: { agentId: `agent-${id}` } }, suspended: null } as unknown as Run;
}

function setup(over: Partial<UsageLimitSettings> = {}, file: string | null = null) {
  let time = Date.UTC(2026, 9, 29, 14, 0);
  const runs: Run[] = [];
  const mails: { to: string; subject: string; body: string }[] = [];
  const resumed: string[] = [];
  const probeQueue: ({ kind: "completed" | "failed"; message?: string } | null)[] = [];
  let probes = 0;
  let manualSuspension = false;
  const ports: ControllerPorts = {
    now: () => time,
    settings: () => ({ ...SETTINGS, ...over }),
    runs: () => runs,
    factorySuspended: () => manualSuspension,
    async suspend(id, input: { reason: string; by: string; usageLimit: UsageLimitHold }) {
      const r = runs.find((x) => x.id === id)!;
      r.suspended = { reason: input.reason, at: time, by: input.by, prevStatus: r.status, pods: [], usageLimit: input.usageLimit };
      r.status = "suspended";
    },
    async unsuspend(id) {
      const r = runs.find((x) => x.id === id)!;
      r.status = r.suspended?.prevStatus ?? "running";
      r.suspended = null;
      resumed.push(id);
    },
    async probe() {
      probes++;
      return probeQueue.shift() ?? { kind: "completed" };
    },
    async report(to, r) {
      mails.push({ to, subject: r.subject, body: r.body });
    },
    log: () => undefined,
  };
  const c = new UsageLimits(new UsageLimitFile(file), ports);
  /** A worker hit the limit: the engine holds the run (own), then tells the controller. */
  const hit = (id: string, resetAt: number | null = null) => {
    const r = runs.find((x) => x.id === id)!;
    const global = c.globalHold();
    r.suspended = { reason: "paused: quota", at: time, by: "factory", prevStatus: "running", pods: [], usageLimit: { source: global ? "global" : "own", rule: "claude-limit-reached", evidence: LIMIT, provider: "claude", agentId: `agent-${id}`, resetAt, resumeAt: global ? null : c.resumeAtFor(resetAt) } };
    r.status = "suspended";
    c.matched({ runId: id, agentId: `agent-${id}`, provider: "claude", rule: "claude-limit-reached", evidence: LIMIT, resetAt });
  };
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  return { c, runs, mails, resumed, probeQueue, hit, flush, probes: () => probes, advance: (ms: number) => (time += ms), now: () => time, setManual: (v: boolean) => (manualSuspension = v) };
}

describe("usage limits: one match holds only its run", () => {
  it("records the match, schedules a confirming probe, and does not hold the Factory", async () => {
    const t = setup();
    t.runs.push(run("a"), run("b"));
    t.hit("a");
    expect(t.c.globalHold()).toBeNull();
    expect(t.c.status()).toMatchObject({ state: "run_holds", agents: ["agent-a"] });
    expect(t.runs[1].status).toBe("running");
    expect(t.c.snapshot().probe.dueAt).toBe(t.now() + CONFIRM_PROBE_DELAY_MS);
    expect(t.c.auditLog()[0]).toMatchObject({ event: "run_paused", runId: "a", rule: "claude-limit-reached", evidence: LIMIT });
  });

  it("a passing confirm probe leaves the Factory running; the run resumes at its own time", async () => {
    const t = setup();
    t.runs.push(run("a"), run("b"));
    t.hit("a");
    t.advance(CONFIRM_PROBE_DELAY_MS);
    await t.c.tick();
    expect(t.probes()).toBe(1);
    expect(t.c.globalHold()).toBeNull();
    t.advance(5 * 60_000);
    await t.c.tick(); // queued
    await t.c.tick(); // first batch
    expect(t.resumed).toEqual(["a"]);
    expect(t.mails).toEqual([]);
  });
});

describe("usage limits: a second independent match holds the whole Factory", () => {
  it("another agent within the window: every live run held, the notify list mailed once", async () => {
    const t = setup();
    t.runs.push(run("a"), run("b"), run("c"), run("d", "waiting"));
    t.hit("a");
    t.advance(60_000);
    t.hit("b", t.now() + 3600_000);
    await t.flush();
    expect(t.c.globalHold()).not.toBeNull();
    expect(t.runs.map((r) => r.status)).toEqual(["suspended", "suspended", "suspended", "suspended"]);
    expect(t.runs[2].suspended?.usageLimit).toMatchObject({ source: "global" });
    expect(t.c.status()).toMatchObject({ state: "paused", confirmedBy: "match from agent agent-a (run a)", resumeAt: t.now() + 3600_000 + 60_000 });
    expect(t.mails).toHaveLength(1);
    expect(t.mails[0]).toMatchObject({ to: "@assistant", subject: expect.stringMatching(/^Factory paused/) });
    expect(t.mails[0].body).toMatch(/runs: .*a.*b.*c.*d/);
    expect(t.c.auditLog()[0]).toMatchObject({ event: "global_paused" });
  });

  it("the same run again is not independent", () => {
    const t = setup();
    t.runs.push(run("a"));
    t.hit("a");
    t.runs[0].status = "running";
    t.hit("a");
    expect(t.c.globalHold()).toBeNull();
  });

  it("a match older than confirmMinutes does not count", () => {
    const t = setup();
    t.runs.push(run("a"), run("b"));
    t.hit("a");
    t.advance(16 * 60_000);
    t.hit("b");
    expect(t.c.globalHold()).toBeNull();
  });

  it("a confirming probe that hits the limit holds the Factory", async () => {
    const t = setup();
    t.runs.push(run("a"), run("b"));
    t.hit("a");
    t.probeQueue.push({ kind: "failed", message: LIMIT });
    t.advance(CONFIRM_PROBE_DELAY_MS);
    await t.c.tick();
    await t.flush();
    expect(t.c.status()).toMatchObject({ state: "paused", confirmedBy: "probe" });
    expect(t.runs[1].status).toBe("suspended");
  });

  it("an overloaded probe is inconclusive: no hold", async () => {
    const t = setup();
    t.runs.push(run("a"), run("b"));
    t.hit("a");
    t.probeQueue.push({ kind: "failed", message: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}' });
    t.advance(CONFIRM_PROBE_DELAY_MS);
    await t.c.tick();
    expect(t.c.globalHold()).toBeNull();
    expect(t.c.auditLog()[0]).toMatchObject({ event: "probe", note: expect.stringMatching(/^confirm: inconclusive/) });
  });
});

describe("usage limits: resume", () => {
  async function paused() {
    const t = setup();
    t.runs.push(run("a"), run("b"), run("c"), run("d"), run("e"));
    t.hit("a");
    t.hit("b");
    await t.flush();
    return t;
  }

  it("at resume_at a probe; when it passes, runs resume in batches of resumeConcurrency every resumeStaggerSeconds", async () => {
    const t = await paused();
    const at = t.c.status().resumeAt!;
    t.advance(at - t.now() - 1000);
    await t.c.tick();
    expect(t.probes()).toBe(0);
    t.advance(1000);
    await t.c.tick();
    expect(t.probes()).toBe(1);
    expect(t.c.globalHold()).toBeNull();
    expect(t.resumed).toEqual(["a", "b"]);
    await t.c.tick();
    expect(t.resumed).toHaveLength(2); // staggered
    t.advance(60_000);
    await t.c.tick();
    expect(t.resumed).toEqual(["a", "b", "c", "d"]);
    t.advance(60_000);
    await t.c.tick();
    expect(t.resumed).toEqual(["a", "b", "c", "d", "e"]);
    expect(t.mails.map((m) => m.subject)).toEqual([expect.stringMatching(/^Factory paused/), "Factory resumed after the usage limit"]);
  });

  it("a probe still refused keeps the hold, backing off 10 then 15 minutes", async () => {
    const t = await paused();
    t.advance(t.c.status().resumeAt! - t.now());
    t.probeQueue.push({ kind: "failed", message: LIMIT }, { kind: "failed", message: LIMIT });
    await t.c.tick();
    expect(t.c.status().resumeAt).toBe(t.now() + 10 * 60_000);
    t.advance(10 * 60_000);
    await t.c.tick();
    expect(t.c.status().resumeAt).toBe(t.now() + 15 * 60_000);
    expect(t.resumed).toEqual([]);
  });

  it("a person lifts it: no probe, runs resume staggered, the list is told", async () => {
    const t = await paused();
    const out = t.c.lift("louis");
    await t.flush();
    expect(out.ok).toBe(true);
    expect(t.probes()).toBe(0);
    expect(t.resumed).toEqual(["a", "b"]);
    expect(t.c.auditLog().find((e) => e.event === "lifted")).toMatchObject({ by: "louis" });
    expect(t.mails.at(-1)?.subject).toBe("Factory usage-limit pause lifted by a person");
  });

  it("nothing resumes while a person's Factory-wide suspension is on", async () => {
    const t = await paused();
    t.setManual(true);
    t.advance(24 * 3600_000);
    await t.c.tick();
    expect(t.probes()).toBe(0);
    expect(t.resumed).toEqual([]);
  });

  it("the hold survives a restart (state file)", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "ul-")), "usage-limit.json");
    const t = setup({}, file);
    t.runs.push(run("a"), run("b"));
    t.hit("a");
    t.hit("b");
    await t.flush();
    const again = new UsageLimits(new UsageLimitFile(file), { now: t.now, settings: () => SETTINGS, runs: () => t.runs, factorySuspended: () => false, suspend: async () => undefined, unsuspend: async () => undefined, log: () => undefined });
    expect(again.globalHold()).not.toBeNull();
    expect(again.auditLog().map((e) => e.event)).toContain("global_paused");
  });
});

describe("usage limits: unknown errors", () => {
  it("one alert per signature to unknownAlertTo", async () => {
    const t = setup();
    t.c.unknown({ runId: "a", agentId: "x", failure: { message: "Weird provider failure 1234 at step 7" } });
    t.c.unknown({ runId: "b", agentId: "y", failure: { message: "Weird provider failure 99 at step 2" } });
    t.c.unknown({ runId: "c", agentId: "z", failure: { message: "Another failure" } });
    await t.flush();
    expect(t.mails.map((m) => m.to)).toEqual(["@user", "@user"]);
    expect(t.c.auditLog().filter((e) => e.event === "unknown_alert")).toHaveLength(2);
  });
});
