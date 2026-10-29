import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Scheduler, StateFile, type RunSnapshot, type StartResult } from "./scheduler";
import { parseEntries, type Schedule } from "./schedules";

const at = (iso: string) => Date.parse(iso);
const sched = (over: Record<string, unknown> = {}): Schedule[] =>
  parseEntries([{ id: "nightly", cron: "0 9 * * 1-5", timezone: "Europe/Paris", blueprint: "bp", vars: { a: "1" }, ...over }], "test").schedules;

function harness() {
  const runs: RunSnapshot[] = [];
  const starts: { blueprint: string; vars: Record<string, string>; requestedBy: string; idempotencyKey: string }[] = [];
  const mails: { to: string; subject: string; body: string }[] = [];
  const logs: string[] = [];
  let nextStart: StartResult | null = null;
  let mailError: string | null = null;
  const file = path.join(mkdtempSync(path.join(tmpdir(), "crons-state-")), "crons.json");
  const ports = {
    runs: () => runs.map((r) => ({ ...r })),
    start: (i: (typeof starts)[number]): StartResult => {
      if (nextStart) return nextStart;
      starts.push(i);
      const id = `bp-${starts.length}`;
      runs.push({ id, status: "running", vars: i.vars });
      return { ok: true, runId: id };
    },
    mail: async (m: { to: string; subject: string; body: string }) => (mailError ? mailError : (mails.push(m), null)),
    log: (l: string) => void logs.push(l),
  };
  const make = () => new Scheduler(new StateFile(file), ports);
  const end = (id: string, status: string) => (runs.find((r) => r.id === id)!.status = status);
  return { runs, starts, mails, logs, make, end, refuse: (r: StartResult | null) => (nextStart = r), failMail: (e: string | null) => (mailError = e) };
}

describe("Scheduler", () => {
  it("starts a due slot once with the cron vars, requestedBy and idempotency key", async () => {
    const h = harness();
    const s = h.make();
    await s.tick(sched(), at("2026-10-29T07:59:10Z"), "");
    expect(h.starts).toEqual([]);
    await s.tick(sched(), at("2026-10-29T08:00:05Z"), "");
    await s.tick(sched(), at("2026-10-29T08:01:05Z"), "");
    expect(h.starts).toEqual([
      { blueprint: "bp", vars: { a: "1", cron_id: "nightly", cron_slot: "2026-10-29T08:00Z" }, requestedBy: "cron:nightly", idempotencyKey: "cron:nightly:2026-10-29T08:00Z" },
    ]);
    // A restart keeps the handled slot.
    await h.make().tick(sched(), at("2026-10-29T08:02:00Z"), "");
    expect(h.starts.length).toBe(1);
  });

  it("catches up at most 10 minutes, only the latest matching minute, never older", async () => {
    const h = harness();
    await h.make().tick(sched(), at("2026-10-29T07:50:00Z"), "");
    await h.make().tick(sched(), at("2026-10-29T08:09:30Z"), "");
    expect(h.starts.map((x) => x.vars.cron_slot)).toEqual(["2026-10-29T08:00Z"]);
    const late = harness();
    await late.make().tick(sched(), at("2026-10-30T07:50:00Z"), "");
    await late.make().tick(sched(), at("2026-10-30T08:10:00Z"), "");
    expect(late.starts).toEqual([]);
    const every = harness();
    await every.make().tick(sched({ cron: "*/2 * * * *" }), at("2026-10-29T07:50:00Z"), "");
    every.end("bp-1", "done");
    await every.make().tick(sched({ cron: "*/2 * * * *" }), at("2026-10-29T07:57:00Z"), "");
    expect(every.starts.map((x) => x.vars.cron_slot)).toEqual(["2026-10-29T07:50Z", "2026-10-29T07:56Z"]);
  });

  it("skips a slot while a run of the schedule is active, and logs it once", async () => {
    const h = harness();
    h.runs.push({ id: "bp-old", status: "waiting", vars: { cron_id: "nightly" } });
    const s = h.make();
    await s.tick(sched(), at("2026-10-29T07:59:00Z"), "");
    await s.tick(sched(), at("2026-10-29T08:00:00Z"), "");
    await s.tick(sched(), at("2026-10-29T08:01:00Z"), "");
    expect(h.starts).toEqual([]);
    expect(h.logs.filter((l) => l.includes("skipped"))).toEqual(["nightly: slot 2026-10-29T08:00Z skipped, run bp-old is still waiting"]);
  });

  it("tries a slot again while the engine asks to retry, within the window", async () => {
    const h = harness();
    const s = h.make();
    await s.tick(sched(), at("2026-10-29T07:59:00Z"), "");
    h.refuse({ ok: false, retry: true, error: "suspended" });
    await s.tick(sched(), at("2026-10-29T08:00:00Z"), "");
    h.refuse(null);
    await s.tick(sched(), at("2026-10-29T08:02:00Z"), "");
    expect(h.starts.map((x) => x.vars.cron_slot)).toEqual(["2026-10-29T08:00Z"]);
  });

  it("pauses after maxFailures failed runs in a row, mails once, and resumes", async () => {
    const h = harness();
    const s = h.make();
    const minute = sched({ cron: "* * * * *", mailTo: "@ops" });
    await s.tick(minute, at("2026-10-29T08:00:00Z"), "@default");
    h.end("bp-1", "done");
    await s.tick(minute, at("2026-10-29T08:01:00Z"), "@default");
    h.end("bp-2", "failed");
    await s.tick(minute, at("2026-10-29T08:02:00Z"), "@default");
    expect(s.snapshot().schedules.nightly!.consecutiveFailures).toBe(1);
    h.end("bp-3", "aborted");
    await s.tick(minute, at("2026-10-29T08:03:00Z"), "@default");
    await s.tick(minute, at("2026-10-29T08:04:00Z"), "@default");
    expect(h.starts.length).toBe(3);
    expect(s.snapshot().schedules.nightly).toMatchObject({ paused: true, pausedBy: "failures", lastRunId: "bp-3", lastResult: "aborted" });
    expect(h.mails.map((m) => m.to)).toEqual(["@ops"]);
    expect(h.mails[0]!.subject).toContain("nightly paused");

    s.resume("nightly", "test");
    await s.tick(minute, at("2026-10-29T08:05:00Z"), "@default");
    expect(h.starts.length).toBe(4);
    expect(s.snapshot().schedules.nightly!.consecutiveFailures).toBe(0);
  });

  it("uses the default address, and gives up a mail that keeps failing", async () => {
    const h = harness();
    const s = h.make();
    const minute = sched({ cron: "* * * * *", maxFailures: 1 });
    h.failMail("down");
    await s.tick(minute, at("2026-10-29T08:00:00Z"), "@default");
    h.end("bp-1", "failed");
    for (let i = 1; i <= 7; i++) await s.tick(minute, at(`2026-10-29T08:0${i}:00Z`), "@default");
    expect(s.snapshot().schedules.nightly!.mailPending).toBe(false);
    expect(h.logs.filter((l) => l.includes("not sent yet")).length).toBe(4);
    expect(h.logs.some((l) => l.includes("giving up"))).toBe(true);
    const ok = harness();
    const t = ok.make();
    await t.tick(minute, at("2026-10-29T08:00:00Z"), "@default");
    ok.end("bp-1", "failed");
    await t.tick(minute, at("2026-10-29T08:01:00Z"), "@default");
    expect(ok.mails.map((m) => m.to)).toEqual(["@default"]);
  });

  it("resumes when enabled goes from false to true", async () => {
    const h = harness();
    const s = h.make();
    const minute = (enabled: boolean) => sched({ cron: "* * * * *", maxFailures: 1, enabled });
    await s.tick(minute(true), at("2026-10-29T08:00:00Z"), "");
    h.end("bp-1", "failed");
    await s.tick(minute(true), at("2026-10-29T08:01:00Z"), "");
    expect(s.snapshot().schedules.nightly!.paused).toBe(true);
    expect(h.mails).toEqual([]); // no address: only logged
    await s.tick(minute(false), at("2026-10-29T08:02:00Z"), "");
    expect(s.snapshot().schedules.nightly!.paused).toBe(true);
    await s.tick(minute(true), at("2026-10-29T08:03:00Z"), "");
    expect(s.snapshot().schedules.nightly!.paused).toBe(false);
    expect(h.starts.map((x) => x.vars.cron_slot)).toEqual(["2026-10-29T08:00Z", "2026-10-29T08:03Z"]);
  });

  it("pauses and resumes by hand, without a mail", async () => {
    const h = harness();
    const s = h.make();
    const minute = sched({ cron: "* * * * *", mailTo: "@ops" });
    s.pause("nightly", at("2026-10-29T07:59:30Z"));
    await s.tick(minute, at("2026-10-29T08:00:00Z"), "");
    expect(h.starts).toEqual([]);
    expect(s.snapshot().schedules.nightly).toMatchObject({ paused: true, pausedBy: "user" });
    s.resume("nightly", "test");
    await s.tick(minute, at("2026-10-29T08:01:00Z"), "");
    expect(h.starts.map((x) => x.vars.cron_slot)).toEqual(["2026-10-29T08:01Z"]);
    expect(h.mails).toEqual([]);
  });

  it("counts a start the engine refuses as a failure", async () => {
    const h = harness();
    const s = h.make();
    h.refuse({ ok: false, retry: false, error: 'No blueprint "bp".' });
    const minute = sched({ cron: "* * * * *" });
    await s.tick(minute, at("2026-10-29T08:00:00Z"), "@a");
    await s.tick(minute, at("2026-10-29T08:01:00Z"), "@a");
    expect(s.snapshot().schedules.nightly).toMatchObject({ paused: true, lastResult: 'refused: No blueprint "bp".' });
    expect(h.mails.length).toBe(1);
  });

  it("runs now under the one-active-run rule, with its own key", async () => {
    const h = harness();
    const s = h.make();
    const [one] = sched();
    const first = s.runNow(one!, at("2026-10-29T10:15:20Z"));
    expect(first).toEqual({ ok: true, runId: "bp-1", message: null });
    expect(h.starts[0]).toMatchObject({ idempotencyKey: "cron:nightly:now:2026-10-29T10:15Z", requestedBy: "cron:nightly", vars: { cron_id: "nightly", cron_slot: "2026-10-29T10:15Z" } });
    const again = s.runNow(one!, at("2026-10-29T10:16:00Z"));
    expect(again).toMatchObject({ ok: false, runId: null, message: expect.stringContaining("bp-1 of nightly is still running") });
    h.end("bp-1", "done");
    expect(s.runNow(one!, at("2026-10-29T10:17:00Z"))).toMatchObject({ ok: true, runId: "bp-2" });
    // Its outcome counts like a scheduled run's.
    h.end("bp-2", "failed");
    await s.tick(sched(), at("2026-10-29T10:18:00Z"), "");
    expect(s.snapshot().schedules.nightly).toMatchObject({ consecutiveFailures: 1, lastRunId: "bp-2", lastResult: "failed" });
  });
});
