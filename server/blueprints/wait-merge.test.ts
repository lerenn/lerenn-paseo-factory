import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Engine, type GateState, type PrFacts, type Ports } from "./engine";
import { RunStore } from "./store";
import { parseBlueprint } from "./toml";
import { settingsSchema } from "../../shared/blueprints/settings";

const ticket = readFileSync(path.join(__dirname, "..", "..", "shared", "examples", "blueprints", "ticket.toml"), "utf8");
const PR = "https://github.com/acme/api/pull/7";
const pr = (state: PrFacts["state"], head = "aaa111"): PrFacts => ({ url: PR, exists: true, state, head, ci: "green", mergeable: true, draft: false, review: "" });

function setup(opts: { criteriaReminderMinutes?: number; eventsMailTo?: string } = {}) {
  let time = 1_000_000;
  let agents = 0;
  const mails: { to: string; subject: string; body: string }[] = [];
  const items = new Map<string, GateState>();
  const facts = { pr: pr("open") };
  const store = new RunStore(null);
  const ports: Ports = {
    now: () => time,
    async spawn() {
      return { agentId: `agent-${++agents}` };
    },
    async send() {},
    async report(to, r) {
      mails.push({ to, subject: r.subject, body: r.body });
    },
    async agentState() {
      return "running";
    },
    async archive() {},
    ask(o) {
      const itemId = `item-${items.size + 1}`;
      items.set(itemId, { status: "pending", optionId: null, text: o.question, by: null });
      return { itemId };
    },
    gate: (id) => items.get(id) ?? null,
    withdraw() {},
    wardenRegister: () => null,
    wardenDone() {},
    async prFacts() {
      return facts.pr;
    },
    tool: () => null,
    stageKind: () => null,
    blueprint: () => parseBlueprint(ticket),
    post: () => ({ eventsMailTo: opts.eventsMailTo ?? "@assistant", retro: { enabled: false, mailTo: "@user", role: "retro", maxUsd: 0.3, timeoutMinutes: 10, skipTrivial: true }, janitor: { enabled: false, dryRun: true } }),
    settings: () => ({ defaultCwd: "/w", pmRole: "pm", idleGraceSeconds: 90, archiveOnFinish: false, criteriaReminderMinutes: opts.criteriaReminderMinutes }),
  };
  const engine = new Engine(store, ports);
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  const startAt = async (at: string) => {
    const run = engine.start({ blueprint: "ticket", vars: { ticket: "ABC-1", ticket_confirmed: "true" }, requestedBy: "x", at });
    run.stages.investigate = { ...run.stages.investigate, status: "done", data: { criteria: "1. works" }, summary: "inv" } as never;
    run.stages.implement = { ...run.stages.implement, status: "done", notes: [], runs: 1, attempts: 0, extra: 0, flakes: 0, data: { pr_urls: [PR] } } as never;
    await settle();
    return run;
  };
  const verdict = async (agent: string, v: string, summary = "") => {
    await engine.verdict(agent, { verdict: v, data: {}, summary });
    await settle();
  };
  const tick = async () => {
    await engine.tick();
    await settle();
  };
  return { engine, mails, items, facts, startAt, verdict, tick, settle, advance: (ms: number) => (time += ms) };
}

describe("ticket blueprint: QA pending_merge", () => {
  it("waits for the merge without opening an Inbox item, mails once, then runs QA again", async () => {
    const t = setup();
    const run = await t.startAt("qa");
    await t.verdict("agent-1", "pending_merge", "criterion 2 needs the merged code");
    expect(t.engine.require(run.id)).toMatchObject({ stage: "wait-merge", status: "waiting" });
    expect(t.items.size).toBe(0);
    const mails = t.mails.filter((m) => m.subject.includes("wait-merge"));
    expect(mails).toHaveLength(1);
    expect(mails[0].body).toContain(PR);
    expect(mails[0].body).toContain("criterion 2 needs the merged code");

    await t.tick();
    expect(t.engine.require(run.id).stage).toBe("wait-merge");
    t.facts.pr = pr("merged");
    await t.tick();
    expect(t.engine.require(run.id)).toMatchObject({ stage: "qa", status: "running" });
    expect(t.engine.require(run.id).stages["wait-merge"]).toMatchObject({ verdict: "merged", status: "done" });
    expect(t.items.size).toBe(0);

    // QA ran after the merge: no babysitting, the merge gate completes by itself, then the release step
    await t.verdict("agent-2", "pass");
    expect(t.engine.require(run.id)).toMatchObject({ stage: "merge", status: "waiting" });
    expect(t.engine.require(run.id).stages.babysit.status).toBe("skipped");
    await t.tick();
    expect(t.engine.require(run.id).status).toBe("done");
  });

  it("a head that moves meanwhile sends QA again", async () => {
    const t = setup();
    const run = await t.startAt("qa");
    await t.verdict("agent-1", "pending_merge", "x");
    t.facts.pr = pr("open", "bbb222");
    await t.tick();
    expect(t.engine.require(run.id).stage).toBe("qa");
  });

  it("falls back to the ask-blocked gate after the timeout, with QA's reason", async () => {
    const t = setup();
    const run = await t.startAt("qa");
    await t.verdict("agent-1", "pending_merge", "needs the merged code");
    t.advance(479 * 60_000);
    await t.tick();
    expect(t.engine.require(run.id).stage).toBe("wait-merge");
    t.advance(2 * 60_000);
    await t.tick();
    expect(t.engine.require(run.id)).toMatchObject({ stage: "ask-blocked", status: "waiting" });
    expect(t.items.get("item-1")?.text).toContain("wait-merge (expired)");
    expect(t.items.get("item-1")?.text).toContain("needs the merged code");
  });

  it("aborting ends the wait without touching the Inbox", async () => {
    const t = setup();
    const run = await t.startAt("qa");
    await t.verdict("agent-1", "pending_merge", "x");
    await t.engine.abort(run.id, "no longer needed");
    expect(t.engine.require(run.id).status).toBe("aborted");
  });

  it("a gate that waits for a merge needs pr, a timeout and the merged and expired edges", () => {
    expect(() => parseBlueprint(`version = 1\nname = "x"\n[[stage]]\nid = "a"\nkind = "gate"\nquestion = "q"\nwait = "merge"\n[stage.on]\nmerged = "done"\n`)).toThrow(/needs pr/);
    expect(() => parseBlueprint(`version = 1\nname = "x"\n[[stage]]\nid = "a"\nkind = "gate"\nquestion = "q"\nwait = "merge"\npr = "u"\n[stage.on]\nmerged = "done"\nhead_moved = "a"\n`)).toThrow(/expires_in_minutes/);
  });
});

describe("criteria gate reminders", () => {
  const open = async (t: ReturnType<typeof setup>) => {
    const run = await t.startAt("criteria");
    return run;
  };

  it("mails a reminder every criteriaReminderMinutes, three at most, and none once answered", async () => {
    const t = setup({ criteriaReminderMinutes: 30 });
    const run = await open(t);
    expect(t.engine.require(run.id)).toMatchObject({ stage: "criteria", status: "waiting" });
    const reminders = () => t.mails.filter((m) => m.body.includes("reminder"));
    await t.tick();
    expect(reminders()).toHaveLength(0);
    t.advance(31 * 60_000);
    await t.tick();
    await t.tick();
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0].to).toBe("@assistant");
    expect(reminders()[0].body).toContain("reminder 1/3");
    expect(reminders()[0].body).toContain("31 min");
    for (let i = 0; i < 5; i++) {
      t.advance(31 * 60_000);
      await t.tick();
    }
    expect(reminders()).toHaveLength(3);
  });

  it("stops once the gate is answered", async () => {
    const t = setup({ criteriaReminderMinutes: 30 });
    const run = await open(t);
    t.items.set("item-1", { status: "answered", optionId: "approve", text: null, by: "human" });
    await t.engine.gateResolved("item-1");
    await t.settle();
    expect(t.engine.require(run.id).stage).toBe("implement");
    t.advance(60 * 60_000);
    await t.tick();
    expect(t.mails.filter((m) => m.body.includes("reminder"))).toHaveLength(0);
  });

  it("is off at 0, and sends nothing without events.mailTo", async () => {
    const off = setup({ criteriaReminderMinutes: 0 });
    await open(off);
    off.advance(120 * 60_000);
    await off.tick();
    expect(off.mails.filter((m) => m.body.includes("reminder"))).toHaveLength(0);
    const nobody = setup({ criteriaReminderMinutes: 30, eventsMailTo: "" });
    await open(nobody);
    nobody.advance(120 * 60_000);
    await nobody.tick();
    expect(nobody.mails).toHaveLength(0);
  });

  it("does not remind gates without criteria (ask-blocked)", async () => {
    const t = setup({ criteriaReminderMinutes: 30 });
    await t.startAt("ask-blocked");
    t.advance(120 * 60_000);
    await t.tick();
    expect(t.mails.filter((m) => m.body.includes("reminder"))).toHaveLength(0);
  });

  it("defaults: 30 minutes", () => {
    expect(settingsSchema.parse({}).gates).toEqual({ criteriaReminderMinutes: 30 });
  });
});

describe("merge wait and the merge queue", () => {
  it("shows the PR's queue position and ETA, and says once when it is still queued after 15 min", async () => {
    const t = setup();
    const run = await t.startAt("qa");
    await t.verdict("agent-1", "pending_merge", "needs the merged code");
    t.facts.pr = { ...pr("open"), queued: true, queuePosition: 2, queueEtaSeconds: 300 };
    await t.tick();
    expect(t.engine.require(run.id).waitingFor).toBe(`merge queue: ${PR} #2, ETA ~5 min`);
    const slow = () => t.mails.filter((m) => m.body.includes("still in the merge queue"));
    expect(slow()).toHaveLength(0);
    t.advance(16 * 60_000);
    await t.tick();
    await t.tick();
    expect(slow()).toHaveLength(1);
    expect(slow()[0]!.body).toContain("#2, ETA ~5 min");
    expect(t.engine.require(run.id)).toMatchObject({ stage: "wait-merge", status: "waiting" });
  });
});

describe("decision 9b98fade: a merge wait still in the merge queue at expiry is re-armed", () => {
  it("re-arms while every PR is queued, and expires once a PR leaves the queue", async () => {
    const t = setup();
    const run = await t.startAt("qa");
    await t.verdict("agent-1", "pending_merge", "needs the merged code");
    t.facts.pr = { ...pr("open"), queued: true, queuePosition: 2 };
    t.advance(481 * 60_000);
    await t.tick();
    const live = t.engine.require(run.id);
    expect(live).toMatchObject({ stage: "wait-merge", status: "waiting" });
    expect(live.stages["wait-merge"].gate?.rearms).toBe(1);
    expect(live.history.map((h) => h.event)).toContain("merge_wait_rearmed");
    // still queued but not yet a full timeout since the re-arm: nothing happens
    t.advance(100 * 60_000);
    await t.tick();
    expect(t.engine.require(run.id).stages["wait-merge"].gate?.rearms).toBe(1);
    // dequeued (auto-merge off, out of the queue): the next expiry follows the expired edge
    t.facts.pr = { ...pr("open"), queued: false };
    t.advance(381 * 60_000);
    await t.tick();
    await t.tick();
    expect(t.engine.require(run.id).stage).toBe("ask-blocked");
  });

  it("auto-merge on a red head is not a queue: the wait expires", async () => {
    const t = setup();
    const run = await t.startAt("qa");
    await t.verdict("agent-1", "pending_merge", "x");
    t.facts.pr = { ...pr("open"), queued: true, ci: "red" };
    t.advance(481 * 60_000);
    await t.tick();
    expect(t.engine.require(run.id).stage).toBe("ask-blocked");
  });
});
