import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootPlugin } from "../../testing";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  delete process.env.FACTORY_BLUEPRINTS_DIR;
});

const register = (reg: object) => ((globalThis as any)[Symbol.for("paseo.factory")] as { registerExtension(r: object): () => void }).registerExtension(reg);

/** The plugin with one blueprint whose only stage waits until `release()`, and one schedule in the settings. */
function boot(crons: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), "bp-cron-"));
  writeFileSync(
    path.join(dir, "batch.toml"),
    `name = "batch"\nversion = 1\n[vars.cron_id]\ndefault = ""\n[vars.cron_slot]\ndefault = ""\n[[stage]]\nid = "work"\nkind = "hold"\n[stage.on]\nok = "done"\nerror = "failed"\n`,
  );
  process.env.FACTORY_BLUEPRINTS_DIR = dir;
  const b = bootPlugin({
    blueprints: { crons: { schedules: [{ id: "nightly", cron: "0 9 * * 1-5", timezone: "Europe/Paris", blueprint: "batch" }, { id: "Bad", cron: "x", blueprint: "batch" }], ...crons } },
  });
  cleanups.push(b.cleanup as () => unknown);
  const waiting: ((v: { verdict: string; summary: string }) => void)[] = [];
  cleanups.push(register({ id: "holder", version: "1", tools: [], stageKinds: [{ kind: "hold", run: () => new Promise((r) => waiting.push(r)) }] }));
  const release = (verdict = "ok") => waiting.splice(0).forEach((r) => r({ verdict, summary: verdict }));
  const call = (name: string, input: object = {}) => b.rpc[name]!(input, b.ctx);
  return { ...b, call, release };
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("the Crons RPCs", () => {
  it("list the schedules with their state; crons are off by default, so nothing is due", async () => {
    const { call } = boot({});
    const out = await call("blueprints.crons.list");
    expect(out.enabled).toBe(false);
    expect(out.schedules).toEqual([
      expect.objectContaining({ id: "nightly", cron: "0 9 * * 1-5", timezone: "Europe/Paris", blueprint: "batch", source: "settings", enabled: true, paused: false, nextRunAt: null, activeRun: null, lastRunId: null, lastResult: null, consecutiveFailures: 0, maxFailures: 2 }),
    ]);
    expect(out.errors).toEqual([expect.stringMatching(/^settings: Bad: /)]);
  });

  it("show the next run once crons are on, and pause and resume", async () => {
    const { call } = boot({ enabled: true });
    const listed = await call("blueprints.crons.list");
    expect(listed.enabled).toBe(true);
    expect(listed.schedules[0].nextRunAt).toBeGreaterThan(Date.now());
    expect(await call("blueprints.crons.pause", { id: "nightly" })).toEqual({ ok: true, message: "nightly paused" });
    expect((await call("blueprints.crons.list")).schedules[0]).toMatchObject({ paused: true, nextRunAt: null });
    expect(await call("blueprints.crons.resume", { id: "nightly" })).toEqual({ ok: true, message: "nightly resumed" });
    expect((await call("blueprints.crons.list")).schedules[0]).toMatchObject({ paused: false, nextRunAt: expect.any(Number) });
    expect(await call("blueprints.crons.pause", { id: "nope" })).toEqual({ ok: false, message: 'No cron schedule "nope".' });
  });

  it("run now starts one run at a time, with the cron vars and its own idempotency key", async () => {
    const { call, release } = boot({});
    const first = await call("blueprints.crons.run_now", { id: "nightly" });
    expect(first).toEqual({ ok: true, runId: expect.any(String), message: null });
    const second = await call("blueprints.crons.run_now", { id: "nightly" });
    expect(second).toMatchObject({ ok: false, runId: null, message: expect.stringContaining(`Run ${first.runId} of nightly is still`) });
    const { runs } = await call("blueprints.list", { includeFinished: true });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: first.runId, requestedBy: "cron:nightly" });
    expect(runs[0].vars).toMatchObject({ cron_id: "nightly", cron_slot: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/) });
    expect((await call("blueprints.crons.list")).schedules[0]).toMatchObject({ activeRun: { id: first.runId }, lastRunId: first.runId });

    await until(async () => (release(), (await call("blueprints.list", { includeFinished: true })).runs[0].status), (s) => s === "done");
    const after = (await call("blueprints.crons.list")).schedules[0];
    expect(after).toMatchObject({ activeRun: null, lastRunId: first.runId, lastResult: "done" });
    expect(await call("blueprints.crons.run_now", { id: "missing" })).toMatchObject({ ok: false, message: 'No cron schedule "missing".' });
  });
});
