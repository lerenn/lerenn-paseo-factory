import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine, type GateState, type PrFacts, type Ports } from "./engine";
import { RunStore } from "./store";
import { parseBlueprint } from "./toml";
import { settingsSchema } from "../../shared/blueprints/settings";
import { factsSource, PR_FACTS_RPC } from "./facts-provider";
import { isGitHubPrUrl } from "./github";
import { PrFactsCache } from "./pr-facts-cache";

const ticket = readFileSync(path.join(__dirname, "..", "..", "shared", "examples", "blueprints", "ticket.toml"), "utf8");
const PR = "https://github.com/acme/api/pull/7";
const pr = (state: PrFacts["state"], head = "aaa111"): PrFacts => ({ url: PR, exists: true, state, head, ci: "green", mergeable: true, draft: false, review: "" });

/**
 * How the engine reads the scripted facts: `port` hands them straight to the engine; `fallback` goes through the Factory's
 * cache and facts source with no provider registered (the `gh` path); `provider` through a provider's `pr_facts` rpc, the
 * fallback refusing every read that the rpc answered (and failing like it during an outage). The merge-queue behaviours must not depend on the path.
 */
type FactsPath = "port" | "fallback" | "provider";
const PATHS: FactsPath[] = ["port", "fallback", "provider"];

function setup(opts: { criteriaReminderMinutes?: number; eventsMailTo?: string; path?: FactsPath } = {}) {
  let time = 1_000_000;
  let agents = 0;
  const mails: { to: string; subject: string; body: string }[] = [];
  const items = new Map<string, GateState>();
  // `fail`: every read throws it (a GitHub outage, a missing PR) until it is cleared.
  const facts: { pr: PrFacts; byUrl: Record<string, PrFacts>; fail: unknown } = { pr: pr("open"), byUrl: {}, fail: null };
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
    async prFacts(url) {
      if (facts.fail) throw facts.fail;
      return facts.byUrl[url] ?? facts.pr;
    },
    sleep: async () => {},
    tool: () => null,
    stageKind: () => null,
    blueprint: () => parseBlueprint(ticket),
    post: () => ({ eventsMailTo: opts.eventsMailTo ?? "@assistant", retro: { enabled: false, mailTo: "@user", role: "retro", maxUsd: 0.3, timeoutMinutes: 10, skipTrivial: true }, janitor: { enabled: false, dryRun: true } }),
    settings: () => ({ defaultCwd: "/w", pmRole: "pm", idleGraceSeconds: 90, archiveOnFinish: false, criteriaReminderMinutes: opts.criteriaReminderMinutes }),
  };
  const reads = { provider: 0, fallback: 0 };
  if (opts.path && opts.path !== "port") {
    const scripted = async (url: string) => {
      if (facts.fail) throw facts.fail;
      return { ...(facts.byUrl[url] ?? facts.pr) };
    };
    const rpc = (name: string, { url }: { url: string }) => (opts.path === "provider" && name === PR_FACTS_RPC ? (reads.provider++, scripted(url)) : null);
    const source = factsSource(
      {
        matches: isGitHubPrUrl,
        prDiff: async () => ({ files: 0, additions: 0, deletions: 0 }),
        prFacts: (url) => {
          // Through the provider path, an outage is GitHub's: the gh read behind a failed rpc read fails the same way.
          if (opts.path === "provider" && facts.fail) return Promise.reject(facts.fail);
          reads.fallback++;
          return opts.path === "fallback" ? scripted(url) : Promise.reject(new Error("the fallback must not be read"));
        },
      },
      rpc,
    );
    // ttlMs 0: every read reaches the source, like the scripted port (a merged PR stays cached, as in production).
    const cache = new PrFactsCache({ fetch: source.prFacts, now: () => time, ttlMs: 0 });
    ports.prFacts = (url, o) => cache.get(url, o);
    ports.isPrUrl = source.isPrUrl;
  }
  const engine = new Engine(store, ports);
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  const startAt = async (at: string, prUrls = [PR]) => {
    const run = engine.start({ blueprint: "ticket", vars: { ticket: "ABC-1", ticket_confirmed: "true" }, requestedBy: "x", at });
    run.stages.investigate = { ...run.stages.investigate, status: "done", data: { criteria: "1. works" }, summary: "inv" } as never;
    run.stages.implement = { ...run.stages.implement, status: "done", notes: [], runs: 1, attempts: 0, extra: 0, flakes: 0, data: { pr_urls: prUrls } } as never;
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
  return { engine, mails, items, facts, reads, startAt, verdict, tick, settle, advance: (ms: number) => (time += ms) };
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

describe.each(PATHS)("merge queue behaviours, facts read through the %s path", (path) => {
  afterEach(() => {
    if (path === "port") return;
    // Each test read its facts through the path under test only.
    expect(last!.reads[path === "provider" ? "fallback" : "provider"]).toBe(0);
    expect(last!.reads[path]).toBeGreaterThan(0);
  });
  let last: ReturnType<typeof setup> | null = null;
  const setupPath = (o: Parameters<typeof setup>[0]) => (last = setup(o));

  describe("merge wait and the merge queue", () => {
    it("shows the PR's queue position and ETA, and says once when it is still queued after 15 min", async () => {
      const t = setupPath({ path });
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
      const t = setupPath({ path });
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
      const t = setupPath({ path });
      const run = await t.startAt("qa");
      await t.verdict("agent-1", "pending_merge", "x");
      t.facts.pr = { ...pr("open"), queued: true, ci: "red" };
      t.advance(481 * 60_000);
      await t.tick();
      expect(t.engine.require(run.id).stage).toBe("ask-blocked");
    });
  });

  describe("OPS-378: a merge wait whose PR leaves the merge queue", () => {
    const PR2 = "https://github.com/acme/web/pull/9";
    const at = (url: string, state: PrFacts["state"], extra: Partial<PrFacts> = {}): PrFacts => ({ ...pr(state), url, ...extra });

    it("one PR merges, the other is dequeued: one left-queue notice, and waiting_for names only the unmerged PR", async () => {
      const t = setupPath({ path });
      const run = await t.startAt("qa", [PR, PR2]);
      await t.verdict("agent-1", "pending_merge", "needs the merged code");
      t.facts.byUrl = { [PR]: at(PR, "open", { queued: true, queuePosition: 1 }), [PR2]: at(PR2, "open", { queued: true, queuePosition: 2 }) };
      await t.tick();
      expect(t.engine.require(run.id).waitingFor).toBe(`merge queue: ${PR} #1; ${PR2} #2`);
      // PR merges; PR2 leaves the queue (auto-merge off) without merging
      t.facts.byUrl = { [PR]: at(PR, "merged"), [PR2]: at(PR2, "open", { queued: false }) };
      await t.tick();
      const left = () => t.mails.filter((m) => m.body.includes("left the merge queue"));
      expect(left()).toHaveLength(0); // one read out of the queue is not "left": GitHub flips while it moves the PR
      await t.tick();
      await t.tick();
      await t.tick();
      expect(left()).toHaveLength(1);
      expect(left()[0]!.body).toContain(PR2);
      const live = t.engine.require(run.id);
      expect(live.history.filter((h) => h.event === "merge_left_queue")).toHaveLength(1);
      expect(live.waitingFor).toBe(`merge of ${PR2} (out of the merge queue)`);
      expect(live.waitingFor).not.toContain(PR + " ");
      expect(live).toMatchObject({ stage: "wait-merge", status: "waiting" });
      // re-queued: the wait shows its place again, and it merges
      t.facts.byUrl[PR2] = at(PR2, "open", { queued: true, queuePosition: 1 });
      await t.tick();
      expect(t.engine.require(run.id).waitingFor).toBe(`merge queue: ${PR2} #1`);
      t.facts.byUrl[PR2] = at(PR2, "merged");
      await t.tick();
      expect(t.engine.require(run.id).stage).toBe("qa");
      expect(left()).toHaveLength(1);
    });

    it("no notice for a PR still queued, nor one never queued; a queued set re-arms as before", async () => {
      const t = setupPath({ path });
      const run = await t.startAt("qa", [PR, PR2]);
      await t.verdict("agent-1", "pending_merge", "x");
      t.facts.byUrl = { [PR]: at(PR, "merged"), [PR2]: at(PR2, "open", { queued: true, queuePosition: 1 }) };
      await t.tick();
      await t.tick();
      t.advance(481 * 60_000);
      await t.tick();
      const live = t.engine.require(run.id);
      expect(live.stages["wait-merge"].gate?.rearms).toBe(1);
      expect(live.waitingFor).toBe(`merge queue: ${PR2} #1`);
      expect(live.history.map((h) => h.event)).not.toContain("merge_left_queue");
      // a PR the wait never saw queued is not "out of the queue"
      const u = setupPath({ path });
      const r2 = await u.startAt("qa", [PR, PR2]);
      await u.verdict("agent-1", "pending_merge", "x");
      u.facts.byUrl = { [PR]: at(PR, "open", { queued: false }), [PR2]: at(PR2, "open", { queued: false }) };
      for (let i = 0; i < 4; i++) await u.tick();
      expect(u.engine.require(r2.id).history.map((h) => h.event)).not.toContain("merge_left_queue");
      expect(u.engine.require(r2.id).waitingFor).toBe(`merge of ${PR}, ${PR2}`);
    });
  });

  describe("bp-98295f48: a transient GitHub error never fails a run", () => {
    // Through a provider, an Octokit-like error that says only its status; through gh, the CLI's message.
    const outage = () => (path === "provider" ? Object.assign(new Error("request failed"), { status: 503 }) : new Error("gh: HTTP 500"));
    const events = (t: ReturnType<typeof setup>, id: string) => t.engine.require(id).history.map((h) => h.event);

    it("a 500 as the merge wait opens keeps it waiting, retries with back-off, and goes on once GitHub answers merged", async () => {
      const t = setupPath({ path });
      const run = await t.startAt("qa");
      t.facts.fail = outage();
      await t.verdict("agent-1", "pending_merge", "needs the merged code");
      expect(t.engine.require(run.id)).toMatchObject({ stage: "wait-merge", status: "waiting", error: null });
      expect(t.engine.require(run.id).waitingFor).toContain("GitHub unavailable");
      const retry = t.engine.require(run.id).stages["wait-merge"].factsRetry!;
      expect(retry.at - retry.since).toBe(30_000);
      // still down: the back-off doubles, facts_transient is said once per streak
      t.advance(31_000);
      await t.tick();
      t.advance(61_000);
      await t.tick();
      expect(t.engine.require(run.id).stages["wait-merge"].factsRetry!.n).toBe(3);
      expect(events(t, run.id).filter((e) => e === "facts_transient")).toHaveLength(1);
      expect(t.engine.require(run.id).status).toBe("waiting");
      // GitHub answers: the PRs merged meanwhile, QA runs again
      t.facts.fail = null;
      t.facts.pr = pr("merged");
      t.advance(121_000);
      await t.tick();
      await t.tick();
      expect(t.engine.require(run.id)).toMatchObject({ stage: "qa", status: "running" });
      expect(t.engine.require(run.id).stages["wait-merge"]).toMatchObject({ verdict: "merged", factsRetry: null });
      expect(events(t, run.id)).toContain("facts_recovered");
      expect(events(t, run.id)).not.toContain("failed");
    });

    it("a 500 while polling an open merge wait keeps it waiting, and no poll is made during the back-off", async () => {
      const t = setupPath({ path });
      const run = await t.startAt("qa");
      await t.verdict("agent-1", "pending_merge", "x");
      t.facts.fail = outage();
      await t.tick();
      expect(t.engine.require(run.id)).toMatchObject({ stage: "wait-merge", status: "waiting" });
      expect(t.engine.require(run.id).stages["wait-merge"].factsRetry?.n).toBe(1);
      await t.tick(); // inside the 30 s back-off: no new read
      expect(t.engine.require(run.id).stages["wait-merge"].factsRetry?.n).toBe(1);
      t.facts.fail = null;
      t.facts.pr = pr("merged");
      t.advance(31_000);
      await t.tick();
      expect(t.engine.require(run.id).stage).toBe("qa");
    });

    it("a 30-min streak opens one notice for a person, and the wait still goes on (no expiry on unanswered reads)", async () => {
      const t = setupPath({ path });
      const run = await t.startAt("qa");
      await t.verdict("agent-1", "pending_merge", "x");
      t.facts.fail = outage();
      const notices = () => t.mails.filter((m) => m.body.includes("has not answered the PR reads"));
      for (let i = 0; i < 50; i++) {
        await t.tick();
        t.advance(10 * 60_000);
      }
      expect(notices()).toHaveLength(1);
      expect(events(t, run.id).filter((e) => e === "facts_transient")).toHaveLength(1);
      expect(events(t, run.id).filter((e) => e === "facts_transient_long")).toHaveLength(1);
      expect(t.engine.require(run.id)).toMatchObject({ stage: "wait-merge", status: "waiting" });
      // 500 min, past the 480-min expiry: it does not fire on reads GitHub did not answer
      expect(t.engine.require(run.id).stages["wait-merge"].verdict).toBeNull();
    });

    it("a 404 still fails the run as before; a resume on a 500 is refused and leaves the run as it was", async () => {
      const t = setupPath({ path });
      const run = await t.startAt("qa");
      t.facts.fail = path === "provider" ? Object.assign(new Error("Not Found"), { status: 404 }) : new Error("gh: HTTP 404: Not Found");
      await t.verdict("agent-1", "pending_merge", "x");
      expect(t.engine.require(run.id)).toMatchObject({ status: "failed" });
      expect(t.engine.require(run.id).error).toMatch(/^engine error: .*(404|Not Found)/);

      t.facts.fail = outage();
      const before = JSON.stringify(t.engine.require(run.id));
      await expect(t.engine.resume(run.id, { stage: "wait-merge", note: "retry" })).rejects.toThrow(/GitHub unavailable.*try again/);
      expect(JSON.stringify(t.engine.require(run.id))).toBe(before);

      t.facts.fail = null;
      await t.engine.resume(run.id, { stage: "wait-merge" });
      await t.settle();
      expect(t.engine.require(run.id)).toMatchObject({ stage: "wait-merge", status: "waiting", error: null });
    });

    it("a Resume chosen in the Inbox on a 500 is refused with a notice and never changes the run", async () => {
      const t = setupPath({ path });
      const run = await t.startAt("qa");
      t.facts.fail = new Error("HTTP 404: Not Found");
      await t.verdict("agent-1", "pending_merge", "x");
      const live = t.engine.require(run.id);
      expect(live.status).toBe("failed");
      // the failed run's own escalation, answered "resume" while GitHub is down
      (live.escalations ??= {})["esc-1"] = { stage: "wait-merge" } as never;
      t.items.set("esc-1", { status: "answered", optionId: "resume", text: null, by: "louis" });
      t.facts.fail = outage();
      await t.engine.gateResolved("esc-1");
      await t.settle();
      expect(t.engine.require(run.id)).toMatchObject({ status: "failed", stage: "wait-merge" });
      expect(events(t, run.id)).toContain("resume_refused");
      expect(t.mails.some((m) => m.body.includes("GitHub unavailable"))).toBe(true);
    });

    it("a gate answer GitHub cannot check is kept, not failed, and applied once GitHub answers", async () => {
      const t = setupPath({ path });
      const run = await t.startAt("merge");
      expect(t.engine.require(run.id)).toMatchObject({ stage: "merge", status: "waiting" });
      const itemId = t.engine.require(run.id).stages.merge.gate!.itemId;
      t.facts.fail = outage();
      t.items.set(itemId, { status: "answered", optionId: "merged", text: null, by: "louis" });
      await t.engine.gateResolved(itemId);
      await t.settle();
      expect(t.engine.require(run.id)).toMatchObject({ stage: "merge", status: "waiting", error: null });
      expect(events(t, run.id)).toContain("facts_transient");
      t.facts.fail = null;
      t.facts.pr = pr("merged");
      t.advance(31_000);
      await t.tick();
      expect(t.engine.require(run.id).stages.merge).toMatchObject({ status: "done", verdict: "merged", factsRetry: null });
      expect(t.engine.require(run.id).status).not.toBe("failed");
    });
  });
});
