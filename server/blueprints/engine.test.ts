import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Engine, MAX_PROGRESS, UsageError, type GateState, type PrFacts, type Ports } from "./engine";
import { RunStore } from "./store";
import type { PmSettings } from "./pm";
import { parseBlueprint } from "./toml";

const flow = `
version = 1
name = "flow"
confirm = ["ticket"]
[vars.ticket]
required = true
pattern = "^[A-Z]+-[0-9]+$"
[vars.bump]
default = "false"

[[stage]]
id = "think"
role = "investigator"
prompt = "Investigate {{ticket}}"
max_attempts = 2
flake_retries = 1
[stage.on]
fix = "criteria"
nothing = "done"
exhausted = "pm"

[[stage]]
id = "criteria"
kind = "gate"
skip_if = "{{bump}} == true"
question = "Criteria for {{ticket}}?"
criteria = "{{stage.think.data.criteria}}"
[stage.on]
approve = "build"
deny = "think"
skipped = "build"

[[stage]]
id = "build"
role = "implementer"
prompt = "Build {{ticket}}"
max_attempts = 2
facts = "pr"
[stage.on]
done = "check"
exhausted = "pm"
[stage.verify]
done = ["exists", "open"]

[[stage]]
id = "check"
role = "qa"
facts = "pr"
pr_urls_from = "build"
max_runs = 2
prompt = "Check {{ticket}}"
[stage.on]
pass = "land"
fail = "repair"
exhausted = "pm"

[[stage]]
id = "repair"
role = "implementer"
agent = "reuse:build"
prompt = "Repair: {{stage.check.summary}}"
[stage.on]
done = "check"

[[stage]]
id = "land"
kind = "gate"
question = "Merge?"
pr = "{{stage.build.data.pr_urls}}"
options = [{ id = "merged", label = "Merged" }]
[stage.on]
merged = "done"
head_moved = "check"
`;

/** No on-demand PM: judgement points go to the human, as the engine did before PMs. */
const NO_PM = { maxPerRun: 0 };

function setup(source = flow, over: { flakeRetries?: number; runsMailTo?: string; pods?: boolean; pm?: Partial<PmSettings>; escalationTarget?: string; verdictNudge?: boolean; worktree?: { ok: boolean; detail: string; unchecked?: boolean }[] } = {}, withReport = false) {
  let time = 1_000_000;
  const spawned: { role: string; prompt: string; labels: Record<string, string>; env: Record<string, string>; key: string; workspaceTitle?: string; title: string }[] = [];
  const sent: { to: string; text: string }[] = [];
  const states = new Map<string, "running" | "idle" | "gone">();
  const items = new Map<string, { gate: GateState; question: string; withdrawn: string | null }>();
  const pr: Record<string, PrFacts> = {};
  const wardens: string[] = [];
  const archived: string[] = [];
  const worktreeCalls: { timeoutMs: number; bootMs?: number }[] = [];
  const store = new RunStore(null);
  let agents = 0;
  const spawnErrors: string[] = [];
  const pods = { suspended: [] as string[], woken: [] as string[], busy: new Set<string>() };
  const reports: { to: string; subject: string; body: string; kind: string }[] = [];
  const ports: Ports = {
    now: () => time,
    async spawn(o) {
      const failure = spawnErrors.shift();
      if (failure) throw new Error(failure);
      const agentId = `agent-${++agents}`;
      spawned.push({ role: o.role, prompt: o.prompt, labels: o.labels, env: o.env, key: o.idempotencyKey, workspaceTitle: o.workspaceTitle, title: o.title });
      states.set(agentId, "running");
      return { agentId, workspaceId: over.pods ? `ws-${agents}` : undefined };
    },
    ...(over.pods
      ? {
          async suspendWorkspace(ws: string, force: boolean) {
            if (pods.busy.has(ws) && !force) return { ok: false, message: "busy: a turn is running" };
            pods.suspended.push(ws);
            return { ok: true };
          },
          async wakeWorkspace(ws: string) {
            pods.woken.push(ws);
          },
        }
      : {}),
    async send(to, text) {
      if (states.get(to) === "gone") throw new Error("gone");
      sent.push({ to, text });
    },
    async agentState(id) {
      return states.get(id) ?? "gone";
    },
    async archive(id) {
      archived.push(id);
    },
    ask(o) {
      const itemId = `item-${items.size + 1}`;
      items.set(itemId, { gate: { status: "pending", optionId: null, text: null, by: null }, question: o.question, withdrawn: null });
      return { itemId };
    },
    gate: (id) => items.get(id)?.gate ?? null,
    withdraw(id, reason) {
      const i = items.get(id)!;
      i.gate = { status: "withdrawn", optionId: null, text: null, by: null };
      i.withdrawn = reason;
    },
    wardenRegister: ({ agentId }) => (wardens.push(agentId), `w-${wardens.length}`),
    wardenDone() {},
    async prFacts(url) {
      return pr[url] ?? { url, exists: false, state: "closed", head: "", ci: "none", mergeable: null, draft: false, review: "" };
    },
    ...(over.worktree
      ? {
          worktreeCheck: async (_ws: string, timeoutMs: number, bootMs?: number) => {
            worktreeCalls.push({ timeoutMs, bootMs });
            return over.worktree!.shift() ?? { ok: true, detail: "worktree at abc" };
          },
        }
      : {}),
    ...(withReport ? { report: async (to: string, r: { subject: string; body: string; kind: string }) => void reports.push({ to, ...r }) } : {}),
    tool: () => null,
    stageKind: () => null,
    blueprint: (name) => (name === "flow" ? parseBlueprint(source) : undefined),
    settings: () => ({ defaultCwd: "/w", pmRole: "pm", idleGraceSeconds: 90, archiveOnFinish: false, flakeRetries: over.flakeRetries, runsMailTo: over.runsMailTo, pm: over.pm, verdictNudge: over.verdictNudge }),
    escalationTarget: () => over.escalationTarget ?? "",
  };
  const engine = new Engine(store, ports);
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const answer = async (itemId: string, optionId: string | null, text: string | null = null, by = "human") => {
    items.get(itemId)!.gate = { status: "answered", optionId, text, by };
    await engine.gateResolved(itemId);
    await settle();
  };
  const start = async (vars: Record<string, string> = { ticket: "ABC-1", ticket_confirmed: "true" }, extra: Record<string, unknown> = {}) => {
    const run = engine.start({ blueprint: "flow", vars, requestedBy: "pm", ownerAgentId: "pm-agent", ...extra } as never);
    await settle();
    return run;
  };
  const verdict = async (agent: string, v: string, data: Record<string, unknown> = {}, summary = "") => {
    const out = await engine.verdict(agent, { verdict: v, data, summary });
    await settle();
    return out;
  };
  states.set("pm-agent", "idle");
  return { engine, store, spawned, sent, states, pods, spawnErrors, reports, items, pr, wardens, archived, worktreeCalls, start, verdict, answer, settle, advance: (ms: number) => (time += ms), ports };
}

const okPr = (url: string, head = "abc123"): PrFacts => ({ url, exists: true, state: "open", head, ci: "green", mergeable: true, draft: false, review: "" });
const PR = "https://github.com/acme/api/pull/7";

describe("starting", () => {
  it("needs the confirmed ticket and checks the pattern", () => {
    const { engine } = setup();
    expect(() => engine.start({ blueprint: "flow", vars: { ticket: "ABC-1" }, requestedBy: "x" })).toThrow(/confirmed/);
    expect(() => engine.start({ blueprint: "flow", vars: { ticket: "nope", ticket_confirmed: "true" }, requestedBy: "x" })).toThrow(/match/);
    expect(() => engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" })).toThrow(/required/);
    expect(() => engine.start({ blueprint: "missing", vars: {}, requestedBy: "x" })).toThrow(/No blueprint/);
  });

  it("spawns the first stage's worker with the role, the labels and the env", async () => {
    const { start, spawned, wardens } = setup();
    const run = await start();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].role).toBe("investigator");
    expect(spawned[0].labels).toMatchObject({ "paseo.factory": "1", "paseo.factory.blueprint": "flow", "paseo.factory.run": run.id, "paseo.factory.stage": "think", "paseo.factory.role": "investigator" });
    expect(spawned[0].env).toMatchObject({ PASEO_AGENT_ROLE: "investigator", PASEO_FACTORY_RUN: run.id });
    expect(spawned[0].workspaceTitle).toBe("Investigator: ABC-1");
    expect(spawned[0].prompt).toContain("Investigate ABC-1");
    expect(spawned[0].prompt).toContain("blueprint_verdict");
    expect(wardens).toEqual(["agent-1"]);
  });

  it("is idempotent per key", async () => {
    const { start, spawned } = setup();
    const a = await start(undefined, { idempotencyKey: "k1" });
    const b = await start(undefined, { idempotencyKey: "k1" });
    expect(b.id).toBe(a.id);
    expect(spawned).toHaveLength(1);
  });

  it("enters mid-way with at, without the earlier stages", async () => {
    const { start, spawned } = setup();
    await start(undefined, { at: "build" });
    expect(spawned[0].role).toBe("implementer");
  });
});

describe("setup failures", () => {
  it("a worker that cannot be started pauses the run with the reason instead of burning attempts", async () => {
    const ctx = setup();
    let broken = true;
    const spawn = ctx.ports.spawn;
    ctx.ports.spawn = async (o) => {
      if (broken) throw new Error("No working directory: set defaultCwd");
      return spawn(o);
    };
    const run = await ctx.start();
    const live = ctx.engine.require(run.id);
    expect(live.status).toBe("paused");
    expect(live.error).toMatch(/could not start a worker: No working directory/);
    expect(live.stages.think.attempts).toBe(0);
    expect(live.pm.pending).toBeNull();
    expect([...ctx.items.values()].some((i) => /No working directory/.test(i.question))).toBe(true);
    // fixed: resume goes on from the same stage
    broken = false;
    await ctx.engine.resume(run.id, { stage: "think" });
    await ctx.settle();
    expect(ctx.engine.require(run.id)).toMatchObject({ status: "running", stage: "think" });
    expect(ctx.spawned).toHaveLength(1);
  });

  it("with no PM to ask, an exhausted stage goes straight to the Inbox with the reason", async () => {
    const ctx = setup();
    const run = await ctx.start();
    const spawn = ctx.ports.spawn;
    ctx.ports.spawn = async (o) => {
      if (o.role === "pm") throw new Error("no such role pm");
      return spawn(o);
    };
    ctx.states.set("pm-agent", "gone");
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    const live = ctx.engine.require(run.id);
    expect(live.status).toBe("paused");
    expect(live.error).toMatch(/no PM could be started: no such role pm/);
    expect([...ctx.items.values()].some((i) => /no PM could be started/.test(i.question))).toBe(true);
  });

  it("a run already waiting for a PM that does not exist is moved on at restart: PM spawn, else the Inbox", async () => {
    const a = setup();
    const run = await a.start(undefined, { ownerAgentId: null });
    await a.engine.turnEnded("agent-1", { kind: "completed" });
    await a.settle();
    await a.engine.turnEnded("agent-1", { kind: "completed" });
    await a.settle();
    // simulate the persisted state of the stuck run: waiting, judgement pending, no PM
    const live = a.engine.require(run.id);
    live.status = "waiting";
    live.pmAgentId = null;
    live.pm.pending = { stage: "think", reason: "2 attempts used" };
    delete live.pm.calls; // a run saved before on-demand PMs
    const spawn = a.ports.spawn;
    a.ports.spawn = async (o) => {
      if (o.role === "pm") throw new Error("Expected config.provider in provider/model format");
      return spawn(o);
    };
    const b = new Engine(a.store, a.ports);
    await b.resumeAll();
    await a.settle();
    expect(b.require(run.id)).toMatchObject({ status: "paused" });
    expect(b.require(run.id).error).toMatch(/no PM could be started/);
    expect(await b.hasLivePm(b.require(run.id))).toBe(false);
  });

  it("refuses to start when the blueprint cannot start any worker", () => {
    const ctx = setup();
    ctx.ports.preflight = () => "defaultCwd is not set";
    expect(() => ctx.engine.start({ blueprint: "flow", vars: { ticket: "ABC-1", ticket_confirmed: "true" }, requestedBy: "x" })).toThrow(/defaultCwd is not set/);
  });
});

describe("verdicts", () => {
  it("only the stage's worker may give one, and only a listed one", async () => {
    const { start, engine } = setup();
    await start();
    await expect(engine.verdict("stranger", { verdict: "fix" })).rejects.toThrow(/not the worker/);
    await expect(engine.verdict("agent-1", { verdict: "weird" })).rejects.toThrow(UsageError);
  });

  it("picks the next stage; done ends the run and tells the PM", async () => {
    const { start, verdict, engine, sent } = setup();
    const run = await start();
    await verdict("agent-1", "nothing", {}, "all fine");
    expect(engine.require(run.id).status).toBe("done");
    expect(sent.some((m) => m.to === "pm-agent" && /done/.test(m.text))).toBe(true);
  });

  it("checks PR facts on GitHub, not the worker's word", async () => {
    const { start, verdict, engine, pr } = setup();
    const run = await start(undefined, { at: "build" });
    await expect(engine.verdict("agent-1", { verdict: "done", data: { pr_urls: [PR] } })).rejects.toThrow(/no pull request/);
    await expect(engine.verdict("agent-1", { verdict: "done", data: { pr_urls: ["https://example.com/x"] } })).rejects.toThrow(/not a GitHub pull request/);
    pr[PR] = { ...okPr(PR), state: "closed" };
    await expect(engine.verdict("agent-1", { verdict: "done", data: { pr_urls: [PR] } })).rejects.toThrow(/closed without merging, not open/);
    pr[PR] = okPr(PR);
    await verdict("agent-1", "done", { pr_urls: [PR] });
    expect(engine.require(run.id).stage).toBe("check");
  });

  it("takes a merged PR as passing an \"open\" check (bp-a4ee2a1b)", async () => {
    const { start, verdict, engine, pr } = setup();
    const run = await start(undefined, { at: "build" });
    pr[PR] = { ...okPr(PR), state: "merged" };
    await verdict("agent-1", "done", { pr_urls: [PR] });
    expect(engine.require(run.id).stage).toBe("check");
  });

  it("gives PR stages the PR facts in their prompt", async () => {
    const { start, verdict, pr, spawned } = setup();
    pr[PR] = okPr(PR, "abc123def456");
    await start(undefined, { at: "build" });
    await verdict("agent-1", "done", { pr_urls: [PR] });
    const qa = spawned.find((s) => s.role === "qa")!;
    expect(qa.prompt).toMatch(/PR facts/);
    expect(qa.prompt).toContain(`${PR}: open, head abc123def456, CI green`);
  });
});

describe("attempts, runs and the PM", () => {
  async function exhaust() {
    const ctx = setup();
    const run = await ctx.start();
    await ctx.engine.turnEnded("agent-1", { kind: "completed" }); // nudge: attempt 2 of 2
    await ctx.settle();
    await ctx.engine.turnEnded("agent-1", { kind: "completed" }); // out of attempts
    await ctx.settle();
    return { ...ctx, run };
  }

  it("a turn that ends without a verdict is nudged, and costs an attempt", async () => {
    const { start, engine, sent } = setup();
    await start();
    await engine.turnEnded("agent-1", { kind: "completed" });
    expect(sent.find((m) => m.to === "agent-1")?.text).toMatch(/without giving a verdict/);
  });

  it("exhaustion hands ONE judgement to an on-demand PM, who can grant bounded extra attempts", async () => {
    const { run, engine, sent, spawned } = await exhaust();
    expect(engine.require(run.id)).toMatchObject({ status: "waiting", pm: { pending: { stage: "think" } } });
    const pm = spawned.find((s) => s.role === "pm")!;
    expect(pm.title).toBe(`PM flow ${run.id} · exhausted`);
    expect(pm.labels["paseo.factory.stage"]).toBe("pm");
    expect(pm.key).toBe(`pm:${run.id}:exhausted:think:1`);
    expect(pm.prompt).toMatch(/ONE judgement/);
    expect(sent.some((m) => m.to === "pm-agent")).toBe(false);
    await expect(engine.retry(run.id, { extraAttempts: 5 })).rejects.toThrow(/1 to 2/);
    await engine.retry(run.id, { extraAttempts: 2, note: "look at the logs" });
    expect(engine.require(run.id).status).toBe("running");
    expect(engine.require(run.id).stages.think.extra).toBe(2);
    expect(sent.at(-1)?.text).toMatch(/look at the logs/);
  });

  it("a second exhaustion after the judgement fails the run and escalates through the inbox", async () => {
    const { run, engine, items, settle } = await exhaust();
    await engine.retry(run.id, { extraAttempts: 1 });
    await settle();
    await engine.turnEnded("agent-1", { kind: "completed" });
    await settle();
    expect(engine.require(run.id).status).toBe("failed");
    expect([...items.values()].some((i) => /stuck at stage think/.test(i.question))).toBe(true);
  });

  it("retry is refused when nothing waits for the PM, and the human can resume a failed run", async () => {
    const { run, engine, settle } = await exhaust();
    await engine.retry(run.id, { extraAttempts: 1 });
    await settle();
    await engine.turnEnded("agent-1", { kind: "completed" });
    await settle();
    await expect(engine.retry(run.id, { extraAttempts: 1 })).rejects.toThrow(/not waiting/);
    await engine.resume(run.id, { stage: "think", extraAttempts: 2, note: "try the other repo" });
    await settle();
    expect(engine.require(run.id).status).toBe("running");
  });

  it("a PM can re-scope to another stage with a note", async () => {
    const { run, engine, spawned, settle } = await exhaust();
    await engine.retry(run.id, { to: "build", note: "skip the investigation" });
    await settle();
    expect(engine.require(run.id).stage).toBe("build");
    expect(spawned.at(-1)?.prompt).toContain("skip the investigation");
  });

  it("flaky turns are retried without using an attempt", async () => {
    const { start, engine, settle } = setup();
    const run = await start();
    await engine.turnEnded("agent-1", { kind: "failed", message: "503" });
    await settle();
    expect(engine.require(run.id).stages.think).toMatchObject({ attempts: 1, flakes: 1 });
    expect(engine.require(run.id).status).toBe("running");
  });

  it("max_runs caps the loops of a stage", async () => {
    const { start, engine, verdict, pr, settle } = setup();
    pr[PR] = okPr(PR);
    const run = await start(undefined, { at: "build" });
    await verdict("agent-1", "done", { pr_urls: [PR] }); // build -> check (run 1)
    await verdict("agent-2", "fail", {}, "broken"); // -> repair
    await verdict("agent-1", "done", { pr_urls: [PR] }); // repair (reuse build agent) -> check (run 2)
    await verdict("agent-3", "fail", {}, "still broken"); // -> repair
    await verdict("agent-1", "done", { pr_urls: [PR] }); // -> check, run 3 > max_runs 2 -> PM
    await settle();
    expect(engine.require(run.id)).toMatchObject({ status: "waiting", pm: { pending: { stage: "check" } } });
  });
});

describe("corrections go to the same implementer", () => {
  it("reuse:<stage> sends the repair to the original worker instead of spawning", async () => {
    const { start, verdict, pr, spawned, sent } = setup();
    pr[PR] = okPr(PR);
    await start(undefined, { at: "build" });
    await verdict("agent-1", "done", { pr_urls: [PR] });
    await verdict("agent-2", "fail", {}, "criterion 2 fails");
    const repair = sent.find((m) => /Repair: criterion 2 fails/.test(m.text));
    expect(repair?.to).toBe("agent-1");
    expect(spawned.map((s) => s.role)).toEqual(["implementer", "qa"]);
  });

  it("spawns a replacement with the same role when that worker is gone", async () => {
    const { start, verdict, pr, spawned, states } = setup();
    pr[PR] = okPr(PR);
    await start(undefined, { at: "build" });
    await verdict("agent-1", "done", { pr_urls: [PR] });
    states.set("agent-1", "gone");
    await verdict("agent-2", "fail", {}, "broken");
    expect(spawned.at(-1)).toMatchObject({ role: "implementer" });
    expect(spawned.at(-1)!.prompt).toMatch(/replacement/);
  });
});

describe("gates", () => {
  it("asks through the inbox, takes the answer as the verdict, and reuses an identical approval", async () => {
    const { start, verdict, items, answer, engine } = setup();
    const first = await start();
    await verdict("agent-1", "fix", { criteria: "1. it works" });
    expect(engine.require(first.id)).toMatchObject({ status: "waiting", stage: "criteria" });
    expect(items.get("item-1")?.question).toMatch(/Criteria for ABC-1/);
    await answer("item-1", "approve");
    expect(engine.require(first.id).stage).toBe("build");

    // the same ticket, the same wording: no second question
    const second = await start();
    await verdict("agent-3", "fix", { criteria: "1. it works" });
    expect(items.size).toBe(1);
    expect(engine.require(second.id).stages.criteria.summary).toMatch(/reused/);
    expect(engine.require(second.id).stage).toBe("build");

    // other wording: asked again
    const third = await start();
    await verdict("agent-5", "fix", { criteria: "1. it works fast" });
    expect(items.size).toBe(2);
    expect(engine.require(third.id).stage).toBe("criteria");
  });

  it("finds an approval stored under the key format before approval_scope existed", async () => {
    const { start, verdict, items, engine, store } = setup();
    const sha = createHash("sha256").update("1. it works").digest("hex");
    store.approve(`ABC-1:criteria:${sha}`, "approve", "louis", 1);
    const run = await start();
    await verdict("agent-1", "fix", { criteria: "1. it works" });
    expect(items.size).toBe(0);
    expect(engine.require(run.id).stages.criteria.summary).toMatch(/reused/);
    expect(engine.require(run.id).stage).toBe("build");
  });

  it("keys approvals by a custom approval_scope and names the run by a custom label", async () => {
    const custom = flow.replace('confirm = ["ticket"]', 'confirm = ["ticket"]\nlabel = "{{ticket}} ({{bump}})"\napproval_scope = "{{bump}}"');
    const { start, verdict, answer, items, engine, store, spawned } = setup(custom);
    const first = await start({ ticket: "ABC-1", ticket_confirmed: "true", bump: "no" });
    expect(spawned[0].title).toBe("flow · think · ABC-1 (no)");
    expect(spawned[0].workspaceTitle).toBe("Investigator: ABC-1 (no)");
    expect(engine.view(engine.require(first.id)).label).toBe("ABC-1 (no)");
    await verdict("agent-1", "fix", { criteria: "1. it works" });
    await answer("item-1", "approve");
    const sha = createHash("sha256").update("1. it works").digest("hex");
    expect(store.approval(`no:criteria:${sha}`)).toMatchObject({ optionId: "approve" });
    expect(store.approval(`ABC-1:criteria:${sha}`)).toBeUndefined();
    // another ticket in the same scope reuses it
    const second = await start({ ticket: "XYZ-2", ticket_confirmed: "true", bump: "no" });
    await verdict("agent-3", "fix", { criteria: "1. it works" });
    expect(items.size).toBe(1);
    expect(engine.require(second.id).stages.criteria.summary).toMatch(/reused/);
  });

  it("refuses a label naming an unknown variable", () => {
    expect(() => parseBlueprint(flow.replace('confirm = ["ticket"]', 'confirm = ["ticket"]\nlabel = "{{tikcet}}"'))).toThrow(/unknown variable \{\{tikcet\}\}/);
  });

  it("skip_if follows the skipped edge", async () => {
    const { start, verdict, engine } = setup();
    const run = await start({ ticket: "ABC-2", ticket_confirmed: "true", bump: "true" });
    await verdict("agent-1", "fix", { criteria: "x" });
    expect(engine.require(run.id).stage).toBe("build");
    expect(engine.require(run.id).stages.criteria.status).toBe("skipped");
  });

  it("a PR gate is withdrawn when the head moves, and completes when GitHub shows the merge", async () => {
    const { start, verdict, pr, items, engine, settle } = setup();
    pr[PR] = okPr(PR, "aaa111");
    const run = await start(undefined, { at: "check" });
    run.stages.build = { ...run.stages.check, status: "done", data: { pr_urls: [PR] }, agentId: null } as never;
    await verdict("agent-1", "pass");
    expect(engine.require(run.id)).toMatchObject({ stage: "land", status: "waiting" });
    expect(Object.values(engine.require(run.id).stages.land.gate!.heads)).toEqual(["aaa111"]);

    pr[PR] = okPr(PR, "bbb222");
    await engine.tick();
    await settle();
    expect(items.get("item-1")?.withdrawn).toMatch(/moved/);
    expect(engine.require(run.id).stage).toBe("check");

    await verdict("agent-2", "pass");
    pr[PR] = { ...okPr(PR, "bbb222"), state: "merged" };
    await engine.tick();
    await settle();
    expect(engine.require(run.id).status).toBe("done");
  });

  it("'merged' answered while GitHub still shows the PR open asks again", async () => {
    const { start, verdict, pr, answer, items, engine, settle } = setup();
    pr[PR] = okPr(PR);
    const run = await start(undefined, { at: "check" });
    run.stages.build = { ...run.stages.check, status: "done", data: { pr_urls: [PR] } } as never;
    await verdict("agent-1", "pass");
    await answer("item-1", "merged");
    await settle();
    expect(engine.require(run.id).status).toBe("waiting");
    expect(items.size).toBe(2);
  });

  it("aborting withdraws the open gate", async () => {
    const { start, verdict, items, engine } = setup();
    const run = await start();
    await verdict("agent-1", "fix", { criteria: "c" });
    await engine.abort(run.id, "no longer needed");
    expect(items.get("item-1")?.withdrawn).toMatch(/aborted/);
    expect(engine.require(run.id).status).toBe("aborted");
  });
});

describe("restarts", () => {
  it("a new engine on the same store re-reads a gate that was answered meanwhile", async () => {
    const a = setup();
    const run = await a.start();
    await a.verdict("agent-1", "fix", { criteria: "c" });
    a.items.get("item-1")!.gate = { status: "answered", optionId: "approve", text: null, by: "human" };
    const b = new Engine(a.store, a.ports);
    await b.resumeAll();
    await a.settle();
    expect(b.require(run.id).stage).toBe("build");
  });

  it("a stage caught half way (entering) is dispatched again with the same idempotency key", async () => {
    const a = setup();
    const run = await a.start();
    const st = run.stages.think;
    st.status = "entering";
    st.agentId = null;
    const b = new Engine(a.store, a.ports);
    await b.resumeAll();
    await a.settle();
    expect(a.spawned.map((s) => s.key)).toEqual([`${run.id}:think:1:1`, `${run.id}:think:1:1`]);
  });

  it("a running stage whose worker vanished is nudged back to life", async () => {
    const a = setup();
    const run = await a.start();
    a.states.set("agent-1", "gone");
    const b = new Engine(a.store, a.ports);
    await b.resumeAll();
    await a.settle();
    expect(a.spawned).toHaveLength(2);
    expect(b.require(run.id).stages.think).toMatchObject({ attempts: 1, flakes: 1 });
  });

  it("idle workers without a verdict are caught by the poll even if turn_ended was missed", async () => {
    const a = setup();
    const run = await a.start();
    a.states.set("agent-1", "idle");
    a.advance(120_000);
    await a.engine.tick();
    await a.settle();
    expect(a.engine.require(run.id).stages.think.attempts).toBe(2);
    expect(a.sent.some((m) => m.to === "agent-1" && /without giving a verdict/.test(m.text))).toBe(true);
  });
});

describe("child runs and calls", () => {
  const parent = `
version = 1
name = "flow"
[[stage]]
id = "hand"
kind = "blueprint"
blueprint = "flow"
[stage.on]
done = "done"
failed = "failed"
`;
  it("a call stage runs a Factory tool directly and follows ok / error", async () => {
    const src = `
version = 1
name = "flow"
[[stage]]
id = "join"
kind = "call"
tool = "release_request"
[stage.args]
service = "{{svc}}"
list = ["{{stage.join.data.urls}}"]
[stage.on]
ok = "done"
error = "failed"
[vars.svc]
default = "backend"
`;
    const ctx = setup(src);
    const calls: unknown[] = [];
    ctx.ports.tool = (name) => (name === "release_request" ? async (args) => (calls.push(args), "joined") : null);
    const run = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await ctx.settle();
    expect(calls).toEqual([{ service: "backend", list: [] }]);
    expect(ctx.engine.require(run.id).status).toBe("done");
    void parent;
  });
});

describe("child runs re-attach", () => {
  const parentSrc = `
version = 1
name = "parent"
[[stage]]
id = "hand"
kind = "blueprint"
blueprint = "kid"
[stage.on]
done = "done"
failed = "failed"
`;
  const kidSrc = `
version = 1
name = "kid"
[[stage]]
id = "work"
role = "implementer"
prompt = "Work"
[stage.on]
done = "done"
bad = "failed"
`;
  function family() {
    const ctx = setup();
    ctx.ports.blueprint = (name) => (name === "parent" ? parseBlueprint(parentSrc) : name === "kid" ? parseBlueprint(kidSrc) : undefined);
    const children = (id: string) => ctx.store.all().filter((r) => r.parent?.runId === id);
    return { ctx, children };
  }

  it("a parent resumed while its child still runs waits on the same child, whose end completes the stage", async () => {
    const { ctx, children } = family();
    const run = ctx.engine.start({ blueprint: "parent", vars: {}, requestedBy: "x" });
    await ctx.settle();
    expect(children(run.id)).toHaveLength(1);
    const child = children(run.id)[0]!;
    await ctx.engine.resume(run.id, { stage: "hand" });
    await ctx.settle();
    expect(children(run.id)).toHaveLength(1);
    const p = ctx.engine.require(run.id);
    expect(p.stages.hand).toMatchObject({ status: "waiting", childRunId: child.id });
    expect(p.waitingFor).toBe(`child run ${child.id}`);
    expect(p.history.some((e) => e.event === "child_reattached")).toBe(true);
    await ctx.verdict("agent-1", "done");
    expect(ctx.engine.require(child.id).status).toBe("done");
    expect(ctx.engine.require(run.id)).toMatchObject({ status: "done" });
    expect(ctx.engine.require(run.id).stages.hand.verdict).toBe("done");
  });

  it("a parent resumed at the stage after its child failed starts a new child", async () => {
    const { ctx, children } = family();
    const run = ctx.engine.start({ blueprint: "parent", vars: {}, requestedBy: "x" });
    await ctx.settle();
    await ctx.verdict("agent-1", "bad");
    expect(ctx.engine.require(run.id).status).toBe("failed");
    await ctx.engine.resume(run.id, { stage: "hand" });
    await ctx.settle();
    const kids = children(run.id);
    expect(kids).toHaveLength(2);
    expect(kids[0]!.status).toBe("failed");
    expect(ctx.engine.require(run.id).stages.hand).toMatchObject({ status: "waiting", childRunId: kids[1]!.id });
  });
});

describe("Inbox escalations are multiple choice and act", () => {
  async function stuck() {
    const ctx = setup();
    const run = await ctx.start();
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    // PM judges once and the second exhaustion fails the run with an Inbox item
    await ctx.engine.retry(run.id, { extraAttempts: 1 });
    await ctx.settle();
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    const item = [...ctx.items.entries()].find(([, i]) => /stuck at stage think/.test(i.question))!;
    return { ctx, run, itemId: item[0] };
  }

  it("offers resume +1, resume +3, abort and leave; resume +3 continues the failed run", async () => {
    const { ctx, run, itemId } = await stuck();
    expect(ctx.engine.require(run.id).status).toBe("failed");
    expect(ctx.engine.require(run.id).escalations?.[itemId]).toMatchObject({ stage: "think", kind: "stuck" });
    await ctx.answer(itemId, "resume3");
    expect(ctx.engine.require(run.id)).toMatchObject({ status: "running" });
    expect(ctx.engine.require(run.id).stages.think.extra).toBe(4);
  });

  it("abort aborts, Other passes the text to the worker as a note and resumes", async () => {
    const a = await stuck();
    await a.ctx.answer(a.itemId, "abort");
    expect(a.ctx.engine.require(a.run.id).status).toBe("aborted");
    const b = await stuck();
    await b.ctx.answer(b.itemId, null, "look at the other repo");
    expect(b.ctx.engine.require(b.run.id).status).toBe("running");
    expect(b.ctx.engine.require(b.run.id).stages.think.notes.join(" ")).toMatch(/look at the other repo/);
  });

  it("a setup failure offers Resume (after fixing) and Abort", async () => {
    const ctx = setup();
    let broken = true;
    const spawn = ctx.ports.spawn;
    ctx.ports.spawn = async (o) => {
      if (broken) throw new Error("bad provider");
      return spawn(o);
    };
    const run = await ctx.start();
    const [itemId] = [...ctx.items.keys()];
    broken = false;
    await ctx.answer(itemId, "resume");
    expect(ctx.engine.require(run.id)).toMatchObject({ status: "running" });
    expect(ctx.spawned).toHaveLength(1);
  });
});

describe("gate hold", () => {
  const src = `
version = 1
name = "flow"
[[stage]]
id = "ask"
kind = "gate"
question = "Merge?"
options = [{ id = "merged", label = "Merged / queued", recommended = true }, { id = "hold", label = "Hold" }]
hold_minutes = 60
[stage.on]
merged = "done"
`;
  it("asks the same question again after the hold time", async () => {
    const ctx = setup(src);
    const run = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await ctx.settle();
    await ctx.answer("item-1", "hold");
    expect(ctx.engine.require(run.id)).toMatchObject({ status: "waiting" });
    expect(ctx.items.size).toBe(1);
    await ctx.engine.tick();
    expect(ctx.items.size).toBe(1); // not yet
    ctx.advance(61 * 60_000);
    await ctx.engine.tick();
    await ctx.settle();
    expect(ctx.items.size).toBe(2);
    await ctx.answer("item-2", "merged");
    expect(ctx.engine.require(run.id).status).toBe("done");
  });
});

describe("saved progress of a stage entry (decision a6decaa8)", () => {
  const noLegacy = flow.replace("flake_retries = 1\n", "");

  it("a replacement worker after a pod loss gets the saved results; the same key replaces a record", async () => {
    const { start, engine, spawned, settle } = setup(noLegacy);
    const run = await start();
    engine.workerProgress("agent-1", { key: "1", status: "pass", note: "head abc123: go test ./... ok" });
    engine.workerProgress("agent-1", { key: "2", status: "fail", note: "first try" });
    expect(engine.workerProgress("agent-1", { key: "2", status: "pass", note: "head abc123: curl 200" })).toEqual({ stage: "think", saved: 2 });
    expect(spawned[0].prompt).not.toContain("Progress saved");
    await engine.turnEnded("agent-1", { kind: "failed", message: "pod evicted by the node" });
    await settle();
    expect(spawned).toHaveLength(2);
    const prompt = spawned[1].prompt;
    expect(prompt).toContain("## Progress saved in this stage entry");
    expect(prompt).toContain("- 1: pass");
    expect(prompt).toContain("- 2: pass");
    expect(prompt).toContain("head abc123: curl 200");
    expect(prompt).not.toContain("first try");
    expect(prompt).toContain("Investigate ABC-1"); // the stage prompt is still there
    expect(engine.require(run.id).history.filter((h) => h.event === "progress")).toHaveLength(3);
  });

  it("only the stage's worker saves progress, within bounds", async () => {
    const { start, engine } = setup(noLegacy);
    await start();
    expect(() => engine.workerProgress("stranger", { key: "1", status: "pass" })).toThrow(/not the worker/);
    expect(() => engine.workerProgress("agent-1", { key: "  ", status: "pass" })).toThrow(/key is empty/);
    for (let i = 0; i < MAX_PROGRESS; i++) engine.workerProgress("agent-1", { key: `k${i}`, status: "pass" });
    expect(() => engine.workerProgress("agent-1", { key: "one-more", status: "pass" })).toThrow(/at most/);
    expect(engine.workerProgress("agent-1", { key: "k0", status: "fail" }).saved).toBe(MAX_PROGRESS);
  });

  it("a new entry of the stage starts with no saved progress", async () => {
    const ctx = setup(noLegacy);
    const run = await ctx.start();
    ctx.engine.workerProgress("agent-1", { key: "1", status: "pass" });
    await ctx.verdict("agent-1", "fix", { criteria: "1. it works" });
    const itemId = [...ctx.items.keys()].at(-1)!;
    await ctx.answer(itemId, "deny");
    const r = ctx.engine.require(run.id);
    expect(r.stage).toBe("think");
    expect(r.stages.think.runs).toBe(2);
    expect(r.stages.think.progress).toEqual([]);
  });
});

describe("infrastructure flakes", () => {
  const noLegacy = flow.replace("flake_retries = 1\n", "");
  const patterns: Array<[string, string, string]> = [
    ["Claude Code process exited with code 137", "OOMKilled / exit 137", "exit 137"],
    ["container OOMKilled", "OOMKilled / exit 137", "OOMKilled"],
    ["process terminated: exit code 143", "exit 143 (SIGTERM)", "exit 143"],
    ["kube: could not start the pod: boom", "pod did not start", "pod"],
    ["kube: could not write bridge.mjs in the pod: x", "bridge.mjs not written", "bridge"],
    ["container not found", "container not found", "container"],
    ["channel ended", "channel ended", "channel"],
    ["pod not ready after 120s", "pod not ready", "ready"],
    ["pod evicted by the node", "pod failed / evicted / replaced", "evicted"],
  ];

  it.each(patterns)("%s is a flake: a fresh worker, no attempt used", async (message, reason) => {
    const { start, engine, spawned, states, settle } = setup(noLegacy);
    const run = await start();
    states.set("agent-1", "idle"); // the dead worker still looks alive: it must not be reused
    await engine.turnEnded("agent-1", { kind: "failed", message });
    await settle();
    const r = engine.require(run.id);
    expect(r.stages.think).toMatchObject({ attempts: 1, flakes: 1, flakeReasons: [reason], status: "running" });
    expect(spawned).toHaveLength(2);
    expect(spawned[1].key).not.toBe(spawned[0].key);
    const h = r.history.find((e) => e.event === "flake_retry")!;
    expect(h.detail).toContain(`1/3 ${reason}`);
    expect(h.detail).toContain(message);
  });

  it("a failure to start the pod at spawn time is retried instead of pausing the run", async () => {
    const { start, spawnErrors, engine, spawned, settle } = setup(noLegacy);
    spawnErrors.push("kube: could not start the pod: container not found");
    const run = await start();
    const r = engine.require(run.id);
    expect(r.status).toBe("running");
    expect(r.stages.think).toMatchObject({ attempts: 1, flakes: 1, status: "running" });
    expect(spawned).toHaveLength(1);
    expect(r.history.map((e) => e.event)).toContain("flake_retry");
  });

  it("flake retries are bounded by the setting; past it they are attempts and the stage exhausts with the reasons", async () => {
    const { start, engine, settle, spawned } = setup(noLegacy, { flakeRetries: 2 });
    const run = await start();
    for (const i of [1, 2, 3, 3]) {
      // the third failure is an attempt: the nudge goes to the same worker, whose next failure exhausts the stage
      await engine.turnEnded(`agent-${i}`, { kind: "failed", message: "Claude Code process exited with code 137" });
      await settle();
    }
    const r = engine.require(run.id);
    expect(r.stages.think.flakes).toBe(2);
    expect(r.stages.think.status).toBe("exhausted");
    expect(r.stages.think.attempts).toBe(3); // 1st + two failures counted after the cap
    expect(r.pm.pending?.reason).toContain("infra flakes ×4: OOMKilled / exit 137");
    expect(r.history.filter((e) => e.event === "flake_retry")).toHaveLength(2);
    expect(spawned.filter((s) => s.role !== "pm")).toHaveLength(3);
  });

  it("a stage's flake_retries raises the bound", async () => {
    const { start, engine, settle } = setup(flow.replace("flake_retries = 1", "flake_retries = 4").replace("max_attempts = 2", "max_attempts = 9"), { flakeRetries: 0 });
    const run = await start();
    for (let i = 1; i <= 4; i++) {
      await engine.turnEnded(`agent-${i}`, { kind: "failed", message: "channel ended" });
      await settle();
    }
    expect(engine.require(run.id).stages.think).toMatchObject({ attempts: 1, flakes: 4, status: "running" });
  });

  it("a vanished worker is a flake with a fresh worker", async () => {
    const { start, engine, states, settle, advance, spawned } = setup(noLegacy);
    const run = await start();
    states.set("agent-1", "gone");
    advance(5 * 60_000);
    await engine.tick();
    await settle();
    expect(engine.require(run.id).stages.think).toMatchObject({ attempts: 1, flakes: 1, flakeReasons: ["pod failed / evicted / replaced"] });
    expect(spawned).toHaveLength(2);
  });

  it("not flakes: a turn without a verdict, a provider error without the legacy setting, a normal verdict", async () => {
    const a = setup(noLegacy);
    const run = await a.start();
    await a.engine.turnEnded("agent-1", { kind: "completed" });
    await a.settle();
    expect(a.engine.require(run.id).stages.think).toMatchObject({ attempts: 2, flakes: 0 });
    expect(a.engine.require(run.id).history.some((e) => e.event === "flake_retry")).toBe(false);
    const b = setup(noLegacy);
    const run2 = await b.start();
    await b.engine.turnEnded("agent-1", { kind: "failed", message: "503 overloaded" });
    await b.settle();
    expect(b.engine.require(run2.id).stages.think).toMatchObject({ attempts: 2, flakes: 0 });
    expect(b.spawned).toHaveLength(1);
  });

  it("with the legacy flake_retries a provider error is still retried for free", async () => {
    const { start, engine, settle } = setup(flow);
    const run = await start();
    await engine.turnEnded("agent-1", { kind: "failed", message: "503" });
    await settle();
    expect(engine.require(run.id).stages.think).toMatchObject({ attempts: 1, flakes: 1 });
  });
});

describe("runs.notifyMailTo", () => {
  const NOTHING = { ticket: "ABC-1", ticket_confirmed: "true" };

  it("unset: the starter gets the live message, as before", async () => {
    const { start, verdict, sent, reports } = setup(flow, {}, true);
    await start(NOTHING, { ownerAgentId: "pm-agent" });
    await verdict("agent-1", "nothing");
    expect(reports.map((r) => r.to)).toEqual(["pm-agent"]);
    expect(sent.filter((m) => m.to === "pm-agent")).toHaveLength(0);
  });

  it("set: one mail with run, blueprint and vars to the address, nothing to the starter", async () => {
    const { start, verdict, sent, reports, engine } = setup(flow, { runsMailTo: "@assistant" }, true);
    const run = await start(NOTHING, { ownerAgentId: "pm-agent" });
    await verdict("agent-1", "nothing");
    expect(engine.require(run.id).status).toBe("done");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ to: "@assistant", subject: `Run ${run.id} ABC-1 done`, kind: "run" });
    expect(reports[0].body).toContain(`Run: ${run.id}`);
    expect(reports[0].body).toContain("Blueprint: flow");
    expect(reports[0].body).toContain("ticket=ABC-1");
    expect(reports[0].body).not.toContain("_confirmed");
    expect(sent.filter((m) => m.to === "pm-agent")).toHaveLength(0);
  });

  it("set: a failed run is mailed as failed", async () => {
    const { start, engine, reports } = setup(flow, { runsMailTo: "@assistant" }, true);
    const run = await start(NOTHING, { ownerAgentId: "pm-agent" });
    await engine.abort(run.id, "stop");
    expect(reports.map((r) => r.subject)).toEqual([`Run ${run.id} ABC-1 aborted`]);
  });

  it("set: a stage that needs the PM is mailed, and the PM is neither messaged nor spawned", async () => {
    const { start, engine, reports, sent, spawned, settle } = setup(flow, { runsMailTo: "@assistant" }, true);
    const run = await start(NOTHING, { ownerAgentId: "pm-agent" });
    await engine.turnEnded("agent-1", { kind: "completed" });
    await settle();
    await engine.turnEnded("agent-1", { kind: "completed" });
    await settle();
    expect(engine.require(run.id).status).toBe("waiting");
    expect(reports.map((r) => r.subject)).toEqual([`Run ${run.id} ABC-1 needs PM`]);
    expect(reports[0].body).toContain("blueprint_retry");
    expect(sent.filter((m) => m.to === "pm-agent")).toHaveLength(0);
    expect(spawned.filter((s) => s.role === "pm")).toHaveLength(0);
  });
});

describe("suspending", () => {
  it("holds a run: its pod is suspended, its worker kept, no attempt used, no one prompted", async () => {
    const { start, engine, pods, spawned, sent, states, archived, settle, store } = setup(flow, { pods: true });
    const run = await start();
    await engine.suspend(run.id, { reason: "cost freeze", by: "assistant" });
    const r = engine.require(run.id);
    expect(r.status).toBe("suspended");
    expect(r.suspended).toMatchObject({ reason: "cost freeze", by: "assistant", prevStatus: "running" });
    expect(pods.suspended).toEqual(["ws-1"]);
    expect(r.suspended!.pods[0]).toContain("pod ws-1 suspended");
    expect(archived).toEqual([]);
    expect(store.active()).toHaveLength(0);
    // the worker's pod going away must not be retried, nudged or respawned, by turn end, tick or restart
    states.set("agent-1", "gone");
    await engine.turnEnded("agent-1", { kind: "failed", message: "pod evicted" });
    await engine.tick();
    await engine.resumeAll();
    await settle();
    expect(spawned).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(r.stages.think).toMatchObject({ attempts: 1, flakes: 0, status: "running" });
    expect(engine.view(r).suspended).toMatchObject({ reason: "cost freeze", by: "assistant" });
  });

  it("refuses a verdict while held, and says why", async () => {
    const { start, engine } = setup(flow, { pods: true });
    const run = await start();
    await engine.suspend(run.id, { reason: "freeze", by: "x" });
    await expect(engine.verdict("agent-1", { verdict: "nothing" })).rejects.toThrow(/suspended/);
  });

  it("keeps a busy pod unless forced, and reports it", async () => {
    const { start, engine, pods } = setup(flow, { pods: true });
    pods.busy.add("ws-1");
    const run = await start();
    await engine.suspend(run.id, { reason: "freeze", by: "x" });
    expect(pods.suspended).toEqual([]);
    expect(engine.require(run.id).suspended!.pods[0]).toContain("not suspended (busy");
    const second = await start({ ticket: "ABC-2", ticket_confirmed: "true" });
    pods.busy.add("ws-2");
    await engine.suspend(second.id, { reason: "freeze", by: "x", force: true });
    expect(pods.suspended).toEqual(["ws-2"]);
  });

  it("a local worker (no pod) is just not prompted", async () => {
    const { start, engine } = setup();
    const run = await start();
    await engine.suspend(run.id, { reason: "freeze", by: "x" });
    expect(engine.require(run.id).suspended!.pods[0]).toContain("local");
  });

  it("keeps open gates: the Inbox item stays pending, and an answer given meanwhile is taken on resume", async () => {
    const { start, engine, verdict, items, answer, spawned, settle } = setup(flow, { pods: true });
    const run = await start();
    await verdict("agent-1", "fix", { criteria: "c" });
    expect(engine.require(run.id).status).toBe("waiting");
    await engine.suspend(run.id, { reason: "freeze", by: "x" });
    expect(items.get("item-1")!.gate!.status).toBe("pending");
    expect(items.get("item-1")!.withdrawn).toBeNull();
    await answer("item-1", "approve");
    expect(engine.require(run.id).status).toBe("suspended");
    expect(spawned).toHaveLength(1);
    await engine.unsuspend(run.id);
    await settle();
    expect(engine.require(run.id).stage).toBe("build");
    expect(spawned).toHaveLength(2);
  });

  it("resumes at the same stage and attempt count, waking the existing worker", async () => {
    const { start, engine, pods, spawned, sent, states, wardens, settle } = setup(flow, { pods: true });
    const run = await start();
    states.set("agent-1", "idle");
    await engine.suspend(run.id, { reason: "freeze", by: "x" });
    await engine.unsuspend(run.id, { note: "carry on" });
    await settle();
    const r = engine.require(run.id);
    expect(r.status).toBe("running");
    expect(r.suspended).toBeNull();
    expect(r.stages.think).toMatchObject({ attempts: 1, status: "running", agentId: "agent-1" });
    expect(pods.woken).toEqual(["ws-1"]);
    expect(spawned).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "agent-1" });
    expect(sent[0].text).toContain("was suspended and is resumed");
    expect(sent[0].text).toContain("carry on");
    expect(wardens).toEqual(["agent-1", "agent-1"]); // watched again once woken
  });

  it("spawns a fresh worker with a note when the old one is gone, without using an attempt", async () => {
    const { start, engine, spawned, states, settle } = setup(flow, { pods: true });
    const run = await start();
    await engine.suspend(run.id, { reason: "freeze", by: "x" });
    states.set("agent-1", "gone");
    await engine.resume(run.id, {});
    await settle();
    expect(engine.require(run.id).stages.think).toMatchObject({ attempts: 1, agentId: "agent-2" });
    expect(spawned).toHaveLength(2);
    expect(spawned[1].prompt).toContain("Investigate ABC-1");
    expect(spawned[1].prompt).toContain("you are its replacement");
  });

  it("returns a paused run to paused", async () => {
    const { start, engine, spawnErrors } = setup(flow, { pods: true });
    spawnErrors.push("no provider");
    const run = await start();
    expect(engine.require(run.id).status).toBe("paused");
    await engine.suspend(run.id, { reason: "freeze", by: "x" });
    await engine.unsuspend(run.id);
    expect(engine.require(run.id).status).toBe("paused");
  });

  it("an abort of a suspended run ends it", async () => {
    const { start, engine } = setup(flow, { pods: true });
    const run = await start();
    await engine.suspend(run.id, { reason: "freeze", by: "x" });
    await engine.abort(run.id, "no longer needed");
    expect(engine.require(run.id)).toMatchObject({ status: "aborted", suspended: null });
  });
});

describe("suspending the whole Factory", () => {
  it("suspends every live run, refuses new ones, and survives a reload", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "factory-suspend-"));
    const file = path.join(dir, "blueprints.json");
    try {
      const a = setup(flow, { pods: true });
      const store = new RunStore(file);
      const engine = new Engine(store, a.ports);
      const run = engine.start({ blueprint: "flow", vars: { ticket: "ABC-1", ticket_confirmed: "true" }, requestedBy: "pm" });
      await a.settle();
      await engine.suspendAll({ reason: "maintenance", by: "assistant" });
      expect(engine.require(run.id).status).toBe("suspended");
      expect(() => engine.start({ blueprint: "flow", vars: { ticket: "ABC-2", ticket_confirmed: "true" }, requestedBy: "pm" })).toThrow(/suspended/);

      // the plugin reloads: nothing is respawned
      const again = new RunStore(file);
      expect(again.suspended()).toMatchObject({ reason: "maintenance" });
      const reloaded = new Engine(again, a.ports);
      const before = a.spawned.length;
      await reloaded.resumeAll();
      await reloaded.tick();
      await a.settle();
      expect(a.spawned).toHaveLength(before);
      expect(reloaded.require(run.id).status).toBe("suspended");
      expect(reloaded.require(run.id).suspended).toMatchObject({ reason: "maintenance", by: "assistant" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes all with at most N workers starting at once and lifts the hold", async () => {
    const { start, engine, store, settle, ports } = setup(flow, { pods: true });
    const runs = [];
    for (let i = 1; i <= 5; i++) runs.push(await start({ ticket: `ABC-${i}`, ticket_confirmed: "true" }));
    await engine.suspendAll({ reason: "freeze", by: "x" });
    expect(store.suspended()).not.toBeNull();
    let inFlight = 0;
    let peak = 0;
    const send = ports.send;
    ports.send = async (to, text) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      await send(to, text);
      inFlight -= 1;
    };
    for (const r of runs) (ports as { agentState: Ports["agentState"] }).agentState = async () => "idle";
    const out = engine.resumeAllSuspended({ concurrency: 2 });
    expect(out.runs).toHaveLength(5);
    expect(store.suspended()).toBeNull();
    await out.done;
    await settle();
    expect(peak).toBe(2);
    expect(runs.map((r) => engine.require(r.id).status)).toEqual(Array(5).fill("running"));
    engine.start({ blueprint: "flow", vars: { ticket: "ABC-9", ticket_confirmed: "true" }, requestedBy: "pm" }); // starts again
  });
});

describe("withdrawing stale escalations on resume", () => {
  it("withdraws older pending pause items of the run when it resumes, keeping none behind", async () => {
    const { start, engine, spawnErrors, items, settle } = setup(flow, { pods: true, pm: NO_PM });
    spawnErrors.push("no provider");
    const run = await start();
    expect(engine.require(run.id).status).toBe("paused");
    const first = [...items.keys()][0];
    expect(items.get(first)!.gate!.status).toBe("pending");
    await engine.resume(run.id, { note: "fixed" });
    await settle();
    expect(engine.require(run.id).status).toBe("running");
    expect(items.get(first)!.gate!.status).toBe("withdrawn");
    expect(items.get(first)!.withdrawn).toBe("run resumed");
    expect(engine.require(run.id).escalations).toEqual({});
  });

  it("an answer to a newer escalation withdraws the older ones", async () => {
    const { start, engine, spawnErrors, items, answer, settle } = setup(flow, { pods: true, pm: NO_PM });
    spawnErrors.push("no provider");
    const run = await start();
    const older = [...items.keys()][0];
    // a second pause of the same run while the first item is still pending
    await engine.resume(run.id, {}); // spawns fine; withdraws `older`
    engine.require(run.id).escalations = { [older]: { stage: "think", kind: "setup" } };
    items.get(older)!.gate = { status: "pending", optionId: null, text: null, by: null };
    items.set("item-newer", { gate: { status: "pending", optionId: null, text: null, by: null }, question: "q", withdrawn: null });
    engine.require(run.id).escalations!["item-newer"] = { stage: "think", kind: "setup" };
    await answer("item-newer", "resume");
    await settle();
    expect(items.get(older)!.gate!.status).toBe("withdrawn");
  });
});

describe("a worker whose provider session is gone", () => {
  it("is a free flake: not re-sent to, archived, and replaced by a fresh worker with a note", async () => {
    const { start, engine, spawned, sent, states, archived, settle } = setup(flow.replace("flake_retries = 1\n", ""));
    const run = await start();
    states.set("agent-1", "idle");
    await engine.turnEnded("agent-1", { kind: "failed", message: "No conversation found with session ID 4f2a1c9e-0000-0000-0000-000000000000" });
    await settle();
    const r = engine.require(run.id);
    expect(r.stages.think).toMatchObject({ attempts: 1, flakes: 1, flakeReasons: ["provider session gone"], agentId: "agent-2", status: "running" });
    expect(sent.filter((m) => m.to === "agent-1")).toEqual([]);
    expect(archived).toEqual(["agent-1"]);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].prompt).toContain("you are its replacement");
  });

  it("also when the send itself reports it", async () => {
    const { start, engine, ports, spawned, archived, states, settle } = setup(flow.replace("flake_retries = 1\n", ""));
    const run = await start();
    states.set("agent-1", "idle");
    const send = ports.send;
    ports.send = async (to, text) => {
      if (to === "agent-1") throw new Error("No conversation found with session ID abc");
      await send(to, text);
    };
    await engine.turnEnded("agent-1", { kind: "completed" }); // no verdict: nudged
    await settle();
    expect(engine.require(run.id).stages.think).toMatchObject({ attempts: 1, flakes: 1, agentId: "agent-2" });
    expect(archived).toEqual(["agent-1"]);
    expect(spawned).toHaveLength(2);
  });
});

describe("superseded workers", () => {
  it("archives the previous worker of a stage that spawns a new one, once its turn is over", async () => {
    const { start, engine, spawned, states, archived, settle } = setup();
    const run = await start();
    states.set("agent-1", "idle");
    await engine.resume(run.id, { stage: "think" });
    await settle();
    expect(spawned).toHaveLength(2);
    expect(archived).toEqual(["agent-1"]);
  });

  it("waits for a mid-turn previous worker to end its turn before archiving it", async () => {
    const { start, engine, spawned, states, archived, settle, store } = setup();
    const run = await start();
    await engine.resume(run.id, { stage: "think" }); // agent-1 is still running
    await settle();
    expect(spawned).toHaveLength(2);
    expect(archived).toEqual([]);
    expect(store.get(run.id)!.retiring).toEqual(["agent-1"]);
    states.set("agent-1", "idle");
    await engine.turnEnded("agent-1", { kind: "completed" });
    expect(archived).toEqual(["agent-1"]);
    expect(store.get(run.id)!.retiring).toEqual([]);
    // the new worker is still nudged normally
    await engine.turnEnded("agent-2", { kind: "completed" });
    expect(archived).toEqual(["agent-1"]);
  });

  it("archives the previous worker after a flake retry that is not a gone session", async () => {
    const { start, spawned, states, archived, settle, engine, store } = setup();
    const run = await start();
    states.set("agent-1", "idle");
    await engine.turnEnded("agent-1", { kind: "failed", message: "OOMKilled: exit 137" });
    await settle();
    expect(spawned).toHaveLength(2);
    expect(archived).toContain("agent-1");
    expect(store.get(run.id)!.stages.think.agentId).toBe("agent-2");
  });

  it("does not count an agent no active stage refers to, but keeps unknown agents and the current worker", async () => {
    const { start, engine, states, settle } = setup();
    const run = await start();
    await engine.resume(run.id, { stage: "think" });
    await settle();
    states.set("agent-1", "running");
    expect(engine.isSuperseded("agent-1")).toBe(true);
    expect(engine.isSuperseded("agent-2")).toBe(false);
    expect(engine.isSuperseded("somebody-else")).toBe(false);
    await engine.abort(run.id, "stop");
    expect(engine.isSuperseded("agent-2")).toBe(true);
  });
});

describe("a worker that finished while its stage was paused", () => {
  it("is accepted when it is the stage's latest worker, and recorded in the history", async () => {
    const { start, engine, spawnErrors, verdict, store, settle } = setup();
    const run = await start();
    spawnErrors.push("working directory does not exist");
    await engine.resume(run.id, { stage: "think" });
    await settle();
    expect(store.get(run.id)!.status).toBe("paused");
    expect(store.get(run.id)!.stages.think.agentId).toBe("agent-1");
    expect(store.get(run.id)!.stages.think.status).toBe("entering");
    const out = await verdict("agent-1", "nothing", {}, "done anyway");
    expect(out.next).toBe("done");
    const after = store.get(run.id)!;
    expect(after.status).toBe("done");
    expect(after.history.some((h) => h.event === "late_verdict" && h.detail?.includes("agent-1"))).toBe(true);
  });

  it("is refused when a newer worker exists", async () => {
    const { start, engine, states } = setup();
    const run = await start();
    states.set("agent-1", "idle");
    await engine.resume(run.id, { stage: "think" });
    await expect(engine.verdict("agent-1", { verdict: "nothing" })).rejects.toThrow(/not the worker/);
  });

  it("is refused once the stage is done", async () => {
    const { start, verdict, engine } = setup();
    await start();
    await verdict("agent-1", "nothing");
    await expect(engine.verdict("agent-1", { verdict: "nothing" })).rejects.toThrow(UsageError);
  });
});

describe("blueprint_resume attach_agent", () => {
  it("resumes a paused stage onto its live worker without spawning", async () => {
    const { start, engine, spawnErrors, spawned, sent, store, settle } = setup(flow, { pm: NO_PM });
    const run = await start();
    spawnErrors.push("working directory does not exist");
    await engine.resume(run.id, { stage: "think" });
    await settle();
    await engine.resume(run.id, { stage: "think", attachAgent: "agent-1", note: "carry on" });
    await settle();
    expect(spawned).toHaveLength(1);
    const after = store.get(run.id)!;
    expect(after.status).toBe("running");
    expect(after.stages.think.status).toBe("running");
    expect(after.stages.think.agentId).toBe("agent-1");
    expect(sent.at(-1)).toMatchObject({ to: "agent-1" });
    expect(sent.at(-1)!.text).toContain("carry on");
    expect(after.history.some((h) => h.event === "attached")).toBe(true);
  });

  it("moves a stage from its current worker to another live worker of the role, and retires the old one", async () => {
    const { start, engine, states, archived, store, settle, verdict } = setup();
    const run = await start();
    await engine.resume(run.id, { stage: "think" }); // agent-2 replaces the still running agent-1
    await settle();
    await engine.resume(run.id, { stage: "think", attachAgent: "agent-1" });
    await settle();
    expect(store.get(run.id)!.stages.think.agentId).toBe("agent-1");
    states.set("agent-2", "idle");
    await engine.turnEnded("agent-2", { kind: "completed" }); // not the stage's worker any more: nothing happens
    await settle();
    expect(archived).toContain("agent-2");
    await verdict("agent-1", "nothing");
    expect(store.get(run.id)!.status).toBe("done");
  });

  it("refuses an agent that is gone, not of the run, or of another role", async () => {
    const { start, engine, states } = setup();
    const run = await start();
    await expect(engine.resume(run.id, { stage: "think", attachAgent: "stranger" })).rejects.toThrow(/not a worker of run/);
    await expect(engine.resume(run.id, { stage: "build", attachAgent: "agent-1" })).rejects.toThrow(/runs as investigator/);
    states.set("agent-1", "gone");
    await expect(engine.resume(run.id, { stage: "think", attachAgent: "agent-1" })).rejects.toThrow(/is gone/);
  });
});

describe("merge gate and the merge queue (d82771ac)", () => {
  const src = `
version = 1
name = "flow"
[[stage]]
id = "merge"
kind = "gate"
question = "Merge?"
pr = "${PR}"
options = [{ id = "merged", label = "Merged / queued" }]
[stage.on]
merged = "done"
head_moved = "merge"
`;
  it("waits for the merge without a second question when the PR is queued", async () => {
    const ctx = setup(src);
    ctx.pr[PR] = { ...okPr(PR), queued: true };
    const run = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await ctx.settle();
    await ctx.answer("item-1", "merged");
    let r = ctx.engine.require(run.id);
    expect(r.status).toBe("waiting");
    expect(r.history.some((h) => h.event === "merge_queued")).toBe(true);
    expect(ctx.items.size).toBe(1);
    ctx.pr[PR] = { ...okPr(PR), state: "merged" };
    await ctx.engine.tick();
    await ctx.settle();
    r = ctx.engine.require(run.id);
    expect(r.status).toBe("done");
    expect(ctx.items.size).toBe(1);
  });

  it("asks again when the PR is neither merged nor queued, or leaves the queue", async () => {
    const ctx = setup(src);
    ctx.pr[PR] = { ...okPr(PR), queued: true };
    ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await ctx.settle();
    await ctx.answer("item-1", "merged");
    ctx.pr[PR] = { ...okPr(PR), queued: false };
    await ctx.engine.tick();
    await ctx.settle();
    expect(ctx.items.size).toBe(1); // one poll that misses the PR in the queue is not enough (seen in production)
    await ctx.engine.tick();
    await ctx.settle();
    expect(ctx.items.size).toBe(2);
  });

  it("does not ask again when GitHub's queue answer flips for one poll", async () => {
    const ctx = setup(src);
    ctx.pr[PR] = { ...okPr(PR), queued: true };
    const run = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await ctx.settle();
    await ctx.answer("item-1", "merged");
    for (const queued of [false, true, false, true]) {
      ctx.pr[PR] = { ...okPr(PR), queued };
      await ctx.engine.tick();
      await ctx.settle();
    }
    expect(ctx.items.size).toBe(1);
    expect(ctx.engine.require(run.id).history.some((h) => h.event === "merge_not_seen")).toBe(false);
  });

  it("says once that the queue is slow after stall_minutes, and keeps waiting", async () => {
    const ctx = setup(src);
    ctx.pr[PR] = { ...okPr(PR), queued: true };
    const run = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await ctx.settle();
    await ctx.answer("item-1", "merged");
    ctx.advance(16 * 60_000);
    await ctx.engine.tick();
    await ctx.engine.tick();
    await ctx.settle();
    const r = ctx.engine.require(run.id);
    expect(r.status).toBe("waiting");
    expect(r.history.filter((h) => h.event === "merge_queue_slow")).toHaveLength(1);
    expect(ctx.items.size).toBe(1);
  });
});

describe("pod start failures (d82771ac)", () => {
  it("pauses the run after two pod starts in a row failed, instead of more retries", async () => {
    const ctx = setup(flow, { pm: NO_PM });
    ctx.spawnErrors.push("kube: could not start the pod: boom", "kube: could not start the pod: boom", "kube: could not start the pod: boom");
    const run = await ctx.start();
    const r = ctx.engine.require(run.id);
    expect(r.status).toBe("paused");
    expect(r.history.filter((h) => h.event === "pod_start_failed")).toHaveLength(1);
    expect(ctx.spawnErrors).toHaveLength(1); // the third start was never tried
  });
});

describe("max_active and keys (f36893f5)", () => {
  const src = `
version = 1
name = "flow"
max_active = 1
[[stage]]
id = "think"
role = "investigator"
prompt = "Investigate"
[stage.on]
done = "done"
`;
  it("queues runs past max_active and starts the oldest when a slot frees", async () => {
    const ctx = setup(src);
    const a = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await ctx.settle();
    const b = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await ctx.settle();
    expect(ctx.engine.require(b.id)).toMatchObject({ status: "waiting", stage: null });
    expect(ctx.engine.require(b.id).waitingFor).toMatch(/queued: 1 flow runs active/);
    expect(ctx.spawned).toHaveLength(1);
    await ctx.verdict("agent-1", "done");
    expect(ctx.engine.require(a.id).status).toBe("done");
    await ctx.engine.tick();
    await ctx.settle();
    expect(ctx.engine.require(b.id)).toMatchObject({ status: "running", stage: "think" });
    expect(ctx.spawned).toHaveLength(2);
  });

  it("joins the run of a key, but starts again after that run failed or was aborted", async () => {
    const ctx = setup(src.replace("max_active = 1\n", ""));
    const a = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x", idempotencyKey: "aikido:1" });
    await ctx.settle();
    expect(ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x", idempotencyKey: "aikido:1" }).id).toBe(a.id);
    await ctx.engine.abort(a.id, "test");
    const b = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x", idempotencyKey: "aikido:1" });
    expect(b.id).not.toBe(a.id);
    expect(ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x", idempotencyKey: "aikido:1" }).id).toBe(b.id);
  });
});

describe("a merge wait that stalls (manual-dispatch CI never ran)", () => {
  const src = `
version = 1
name = "flow"
[[stage]]
id = "wait-queue"
kind = "gate"
wait = "merge"
question = "Waiting for the queue"
pr = "${PR}"
expires_in_minutes = 240
stall_minutes = 10
[stage.on]
merged = "done"
head_moved = "wait-queue"
expired = "failed"
stalled = "done"
`;
  it("follows on.stalled when the PR is neither queued nor tested after stall_minutes", async () => {
    const ctx = setup(src);
    ctx.pr[PR] = { ...okPr(PR), ci: "none", queued: false };
    const run = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await ctx.settle();
    await ctx.engine.tick();
    expect(ctx.engine.require(run.id).stage).toBe("wait-queue");
    ctx.advance(11 * 60_000);
    await ctx.engine.tick();
    await ctx.settle();
    const r = ctx.engine.require(run.id);
    expect(r.status).toBe("done");
    expect(r.stages["wait-queue"]).toMatchObject({ verdict: "stalled" });
    expect(r.history.some((h) => h.event === "merge_stalled" && /no CI run on its head/.test(h.detail ?? ""))).toBe(true);
  });

  it("keeps waiting for a PR that is queued", async () => {
    const ctx = setup(src);
    ctx.pr[PR] = { ...okPr(PR), ci: "pending", queued: true };
    const run = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await ctx.settle();
    ctx.advance(30 * 60_000);
    await ctx.engine.tick();
    await ctx.settle();
    expect(ctx.engine.require(run.id)).toMatchObject({ stage: "wait-queue", status: "waiting" });
  });
});

describe("a stage kind whose extension has not registered yet (bp-6a9e18ab)", () => {
  const src = `
version = 1
name = "flow"
[[stage]]
id = "pins"
kind = "train"
[stage.on]
ok = "done"
`;
  it("waits for the extension instead of failing, then runs the stage once it registers", async () => {
    const ctx = setup(src);
    const run = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await ctx.settle();
    let r = ctx.engine.require(run.id);
    expect(r.status).toBe("running");
    expect(r.waitingFor).toContain('extension for stage kind "train"');
    await ctx.engine.tick();
    await ctx.settle();
    expect(ctx.engine.require(run.id).history.filter((h) => h.event === "kind_waiting")).toHaveLength(1);
    const calls: string[] = [];
    ctx.ports.stageKind = () => async (input) => {
      calls.push(input.stageId);
      return { verdict: "ok" };
    };
    ctx.advance(5 * 60_000);
    await ctx.engine.tick();
    await ctx.settle();
    r = ctx.engine.require(run.id);
    expect(calls).toEqual(["pins"]);
    expect(r.status).toBe("done");
  });

  it("fails the run once the extension is still missing after 15 minutes", async () => {
    const ctx = setup(src);
    const run = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await ctx.settle();
    ctx.advance(16 * 60_000);
    await ctx.engine.tick();
    await ctx.settle();
    const r = ctx.engine.require(run.id);
    expect(r.status).toBe("failed");
    expect(r.error).toContain('no extension provides the stage kind "train"');
  });
});

describe("git timeouts on the daemon (decision f1cd49be)", () => {
  it("retries once, then pauses the run and mails instead of six back-off retries", async () => {
    const ctx = setup(undefined, { runsMailTo: "@assistant" }, true);
    const err = "Git command timed out after 90000ms: git rev-parse --show-toplevel";
    ctx.spawnErrors.push(err, err, err);
    const run = await ctx.start();
    expect(ctx.engine.require(run.id).history.filter((h) => h.event === "busy_wait")).toHaveLength(1);
    ctx.advance(2 * 60_000);
    await ctx.engine.tick();
    await ctx.settle();
    const r = ctx.engine.require(run.id);
    expect(r.status).toBe("paused");
    expect(r.history.filter((h) => h.event === "git_timeout_pause")).toHaveLength(1);
    expect(ctx.spawnErrors).toHaveLength(1); // the third start was never tried
  });
});

describe("a worker that waits on an outside system (decision f1cd49be)", () => {
  it("is not nudged while it waits, and the run pauses for a person after the 2 h ceiling", async () => {
    const ctx = setup();
    const run = await ctx.start();
    ctx.states.set("agent-1", "idle");
    ctx.engine.workerWaiting("agent-1", "waiting for the Codex review on acme/api#7");
    const sentBefore = ctx.sent.length;
    for (let i = 0; i < 5; i++) {
      ctx.advance(20 * 60_000);
      await ctx.engine.tick();
      await ctx.settle();
    }
    let r = ctx.engine.require(run.id);
    expect(r.history.some((h) => h.event === "stalled")).toBe(false);
    expect(ctx.sent.length).toBe(sentBefore);
    expect(r.status).toBe("running");
    ctx.advance(25 * 60_000);
    await ctx.engine.tick();
    await ctx.settle();
    r = ctx.engine.require(run.id);
    expect(r.status).toBe("paused");
    expect(r.history.filter((h) => h.event === "worker_wait_ceiling")).toHaveLength(1);
  });

  it("is not nudged when it ends its turns while waiting, and they cost no attempt", async () => {
    const ctx = setup();
    const run = await ctx.start();
    ctx.engine.workerWaiting("agent-1", "waiting for the Codex review on acme/api#7");
    const sentBefore = ctx.sent.length;
    const attempts = ctx.engine.require(run.id).stages[ctx.engine.require(run.id).stage!].attempts;
    for (let i = 0; i < 3; i++) {
      // Each turn end stands for a turn the worker's event mail started; it is still waiting.
      ctx.advance(10 * 60_000);
      await ctx.engine.turnEnded("agent-1", { kind: "completed" });
      await ctx.settle();
    }
    const r = ctx.engine.require(run.id);
    const st = r.stages[r.stage!];
    expect(ctx.sent.length).toBe(sentBefore);
    expect(st.attempts).toBe(attempts);
    expect(st.status).toBe("running");
    expect(r.status).toBe("running");
    expect(r.history.some((h) => h.event === "exhausted" || h.event === "turn_ended")).toBe(false);
    expect(r.history.filter((h) => h.event === "worker_waiting_turn_end")).toHaveLength(3);
  });

  it("pauses for a person when a waiting worker ends its turn past the ceiling", async () => {
    const ctx = setup();
    const run = await ctx.start();
    ctx.engine.workerWaiting("agent-1", "waiting for the merge queue");
    ctx.advance(121 * 60_000);
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    const r = ctx.engine.require(run.id);
    expect(r.status).toBe("paused");
    expect(r.history.filter((h) => h.event === "worker_wait_ceiling")).toHaveLength(1);
  });

  it("still nudges a worker that ends its turn without having declared a wait", async () => {
    const ctx = setup();
    const run = await ctx.start();
    const sentBefore = ctx.sent.length;
    const attempts = ctx.engine.require(run.id).stages[ctx.engine.require(run.id).stage!].attempts;
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    const r = ctx.engine.require(run.id);
    expect(ctx.sent.length).toBeGreaterThan(sentBefore);
    expect(r.stages[r.stage!].attempts).toBe(attempts + 1);
    expect(r.history.some((h) => h.event === "turn_ended")).toBe(true);
  });
});

describe("provider usage limits (usageLimit.enabled)", () => {
  const LIMIT = "Claude AI usage limit reached|1793372460";
  async function withLimits(enabled = true) {
    const { UsageLimits, UsageLimitFile } = await import("./usage-limit/controller");
    const ctx = setup(flow.replace("flake_retries = 1\n", ""), { pods: true }, true);
    const settings = { enabled, notify: [], unknownAlertTo: "@user", confirmMinutes: 15, probeMinutes: 5, probeModel: "", resumeConcurrency: 2, resumeStaggerSeconds: 60, resetZone: "UTC" };
    const controller = new UsageLimits(new UsageLimitFile(null), {
      now: () => ctx.ports.now(),
      settings: () => settings,
      runs: () => ctx.store.all(),
      factorySuspended: () => !!ctx.store.suspended(),
      suspend: (id, input) => ctx.engine.suspend(id, input),
      unsuspend: (id, input) => ctx.engine.unsuspend(id, input),
      report: (to, r) => ctx.ports.report!(to, r),
      log: () => undefined,
    });
    ctx.engine.usageLimits = controller;
    return { ...ctx, controller, settings };
  }

  it("a usage-limit failure holds the run as paused: quota, uses no attempt, nudges nobody", async () => {
    const t = await withLimits();
    const run = await t.start();
    t.states.set("agent-1", "idle");
    t.advance(1793372460_000 - t.ports.now() - 3600_000); // an hour before the reset in the message
    await t.engine.turnEnded("agent-1", { kind: "failed", message: LIMIT, provider: "claude" });
    await t.settle();
    const live = t.engine.require(run.id);
    expect(live.status).toBe("suspended");
    expect(live.suspended?.usageLimit).toMatchObject({ source: "own", rule: "claude-usage-limit-epoch", resetAt: 1793372460_000, resumeAt: 1793372460_000 + 60_000 });
    expect(live.stages.think).toMatchObject({ attempts: 1, flakes: 0 });
    expect(t.sent.filter((m) => m.to === "agent-1")).toHaveLength(0);
    expect(t.spawned).toHaveLength(1);
    expect(t.items.size).toBe(0);
    expect(t.engine.view(live).suspended?.quota).toMatchObject({ source: "own", rule: "claude-usage-limit-epoch" });
    expect(t.controller.status()).toMatchObject({ state: "run_holds", agents: ["agent-1"] });
  });

  it("when its time comes the worker gets a continue prompt at the same attempt", async () => {
    const t = await withLimits();
    const run = await t.start();
    t.states.set("agent-1", "idle");
    await t.engine.turnEnded("agent-1", { kind: "failed", message: "5-hour limit reached ∙ resets 3pm (UTC)" });
    await t.settle();
    t.advance(24 * 3600_000);
    await t.controller.tick();
    await t.settle();
    const live = t.engine.require(run.id);
    expect(live.status).toBe("running");
    expect(live.stages.think.attempts).toBe(1);
    expect(t.sent.at(-1)).toMatchObject({ to: "agent-1", text: expect.stringContaining("the provider usage limit was lifted") });
  });

  it("a second worker's match holds the Factory: no new run starts", async () => {
    const t = await withLimits();
    const a = await t.start({ ticket: "ABC-1", ticket_confirmed: "true" });
    const b = await t.start({ ticket: "ABC-2", ticket_confirmed: "true" });
    const c = await t.start({ ticket: "ABC-3", ticket_confirmed: "true" });
    await t.engine.turnEnded("agent-1", { kind: "failed", message: "Request failed", code: "rate_limit_error" });
    await t.settle();
    await t.engine.turnEnded("agent-2", { kind: "failed", message: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"x"}}' });
    await t.settle();
    expect(t.controller.globalHold()).not.toBeNull();
    expect([a, b, c].map((r) => t.engine.require(r.id).status)).toEqual(["suspended", "suspended", "suspended"]);
    expect(t.engine.require(c.id).suspended?.usageLimit?.source).toBe("global");
    expect(() => t.engine.start({ blueprint: "flow", vars: { ticket: "ABC-4", ticket_confirmed: "true" }, requestedBy: "x" })).toThrow(/usage limit/);
  });

  it("not a usage limit: an overloaded turn takes the normal path, an unknown one also alerts once", async () => {
    const t = await withLimits();
    const run = await t.start();
    await t.engine.turnEnded("agent-1", { kind: "failed", message: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}' });
    await t.settle();
    expect(t.engine.require(run.id).status).toBe("running");
    expect(t.engine.require(run.id).stages.think.attempts).toBe(2);
    await t.engine.turnEnded("agent-1", { kind: "failed", message: "Something nobody has seen" });
    await t.settle();
    expect(t.reports.filter((r) => r.to === "@user")).toHaveLength(1);
  });

  it("switched off (the default): a usage-limit failure is an ordinary failed turn", async () => {
    const t = await withLimits(false);
    const run = await t.start();
    await t.engine.turnEnded("agent-1", { kind: "failed", message: LIMIT });
    await t.settle();
    expect(t.engine.require(run.id).status).toBe("running");
    expect(t.engine.require(run.id).stages.think.attempts).toBe(2);
  });
});

describe("the on-demand run PM (ADR 20261029-factory-on-demand-run-pm)", () => {
  const exhaustThink = async (ctx: ReturnType<typeof setup>) => {
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
  };
  const pms = (ctx: ReturnType<typeof setup>) => ctx.spawned.filter((s) => s.role === "pm");
  const events = (ctx: ReturnType<typeof setup>, id: string) => ctx.engine.require(id).history.map((h) => h.event);

  it("one PM per judgement key, archived with its workspace when its turn ends after it decided", async () => {
    const ctx = setup(flow, { pods: true });
    const run = await ctx.start();
    await exhaustThink(ctx);
    expect(pms(ctx)).toHaveLength(1);
    expect(pms(ctx)[0].env).toMatchObject({ PASEO_FACTORY_STAGE: "pm", PASEO_FACTORY_RUN: run.id });
    expect(pms(ctx)[0].prompt).toContain("<run-digest>");
    const pm = "agent-2";
    const archiveWs: string[] = [];
    ctx.ports.archiveWorkspace = async (ws) => void archiveWs.push(ws);
    // a restart does not spawn a second PM for the same key
    await new Engine(ctx.store, ctx.ports).resumeAll();
    await ctx.settle();
    expect(pms(ctx)).toHaveLength(1);
    await ctx.engine.retry(run.id, { extraAttempts: 2 });
    await ctx.engine.pmDone(pm, run.id, { summary: "granted two attempts, the worker was close" });
    ctx.states.set(pm, "idle");
    await ctx.engine.pmTurnEnded(pm);
    await ctx.settle();
    expect(ctx.archived).toContain(pm);
    expect(archiveWs).toContain("ws-2");
    expect(events(ctx, run.id)).toEqual(expect.arrayContaining(["pm_spawned", "pm_done", "pm_ended"]));
    expect([...ctx.items.values()].map((i) => i.question)).toEqual([]);
  });

  it("a PM that ends its turn without settling the point hands it to the human", async () => {
    const ctx = setup();
    const run = await ctx.start();
    await exhaustThink(ctx);
    ctx.states.set("agent-2", "idle");
    await ctx.engine.pmTurnEnded("agent-2");
    await ctx.settle();
    expect(ctx.archived).toContain("agent-2");
    expect([...ctx.items.values()].some((i) => /stuck at stage think/.test(i.question))).toBe(true);
    expect(events(ctx, run.id)).toContain("pm_to_human");
  });

  it("a failed run gets a PM at its stage; a failed child is judged by its parent", async () => {
    const ctx = setup();
    const run = await ctx.start();
    await ctx.verdict("agent-1", "fix", { criteria: "c" });
    const gate = [...ctx.items.keys()][0];
    await ctx.answer(gate, "nonsense-answer"); // no edge: the run fails
    expect(ctx.engine.require(run.id).status).toBe("failed");
    expect(pms(ctx).map((p) => p.title)).toEqual([`PM flow ${run.id} · failed`]);
    expect(pms(ctx)[0].key).toBe(`pm:${run.id}:failed:criteria:1`);
  });

  it("a pm = true gate spawns a PM that may answer that item only", async () => {
    const gated = flow.replace('question = "Criteria for {{ticket}}?"', 'question = "Criteria for {{ticket}}?"\npm = true');
    const ctx = setup(gated);
    const run = await ctx.start();
    await ctx.verdict("agent-1", "fix", { criteria: "c" });
    const gate = ctx.engine.require(run.id).stages.criteria.gate!.itemId;
    const pm = pms(ctx)[0];
    expect(pm.title).toBe(`PM flow ${run.id} · gate`);
    expect(pm.prompt).toContain(`inbox_answer(item="${gate}"`);
    const pmId = ctx.engine.require(run.id).pmAgentId!;
    expect(ctx.engine.pmMayAnswer(pmId, gate)).toBe(true);
    expect(ctx.engine.pmMayAnswer(pmId, "item-other")).toBe(false);
    expect(ctx.engine.pmMayAnswer("agent-1", gate)).toBe(false);
    await ctx.answer(gate, "approve", null, "pm");
    expect(ctx.engine.require(run.id).stage).toBe("build");
    await ctx.engine.pmDone(pmId, run.id, { summary: "approved: criteria match the ticket" });
    await ctx.engine.pmTurnEnded(pmId);
    expect(ctx.engine.pmMayAnswer(pmId, gate)).toBe(false);
  });

  it("a gate without pm = true spawns no PM", async () => {
    const ctx = setup();
    await ctx.start();
    await ctx.verdict("agent-1", "fix", { criteria: "c" });
    expect(pms(ctx)).toHaveLength(0);
  });

  it("a paused run asks its PM for the resume decision; a PM past its timeout goes to the human", async () => {
    const ctx = setup();
    ctx.spawnErrors.push("No working directory");
    const run = await ctx.start();
    expect(ctx.engine.require(run.id).status).toBe("paused");
    expect(pms(ctx).map((p) => p.title)).toEqual([`PM flow ${run.id} · resume`]);
    expect(ctx.items.size).toBe(0);
    ctx.advance(11 * 60_000);
    await ctx.engine.tick();
    await ctx.settle();
    expect(events(ctx, run.id)).toContain("pm_timeout");
    expect(ctx.archived).toContain("agent-1");
    expect([...ctx.items.values()].some((i) => /paused at stage think/.test(i.question))).toBe(true);
  });

  it("past pm.maxPerRun the human is asked", async () => {
    const ctx = setup(flow, { pm: { maxPerRun: 0 } });
    const run = await ctx.start();
    await exhaustThink(ctx);
    expect(pms(ctx)).toHaveLength(0);
    expect(events(ctx, run.id)).toContain("pm_limit");
    expect(ctx.engine.require(run.id).status).toBe("paused");
  });

  it("with runs.notifyMailTo set nothing is spawned at any point", async () => {
    const ctx = setup(flow, { runsMailTo: "@assistant" }, true);
    ctx.spawnErrors.push("No working directory");
    const run = await ctx.start();
    expect(ctx.engine.require(run.id).status).toBe("paused");
    expect(ctx.items.size).toBe(1);
    await ctx.engine.abort(run.id, "stop");
    expect(pms(ctx)).toHaveLength(0);
  });

  it("escalation: the target first with the worker told, then the human after the timeout; every step in the history", async () => {
    const ctx = setup(flow, { escalationTarget: "supervisor" });
    const run = await ctx.start();
    ctx.engine.workerWaiting("agent-1", "waiting for a review");
    ctx.advance(121 * 60_000);
    await ctx.engine.tick(); // the worker waited past the ceiling: paused, resume point
    await ctx.settle();
    const pm = ctx.engine.require(run.id).pmAgentId!;
    expect(pms(ctx).map((p) => p.title)).toEqual([`PM flow ${run.id} · resume`]);
    const out = await ctx.engine.pmEscalate(pm, run.id, { question: "Is the reviewer away?", bestGuess: "resume and wait", checked: "the PR has no review yet" });
    expect(out).toMatchObject({ target: "supervisor", step: 1, wait_minutes: 30 });
    expect(out.how).toContain("supervisor_ask");
    expect(ctx.sent.some((m) => m.to === "agent-1" && /PM asked supervisor/.test(m.text))).toBe(true);
    ctx.states.set(pm, "idle");
    await ctx.engine.pmTurnEnded(pm); // waiting for the answer: kept
    expect(ctx.archived).not.toContain(pm);
    ctx.advance(31 * 60_000);
    await ctx.engine.tick();
    await ctx.settle();
    expect(ctx.sent.some((m) => m.to === pm && /blocking inbox_ask/.test(m.text))).toBe(true);
    expect(ctx.sent.filter((m) => m.to === "agent-1" && /asks the human/.test(m.text))).toHaveLength(1);
    await expect(ctx.engine.pmEscalate(pm, run.id, { question: "again", bestGuess: "x", checked: "y" })).rejects.toThrow(/already with the human/);
    await ctx.engine.pmAnswer(pm, run.id, { answer: "resume it", by: "human" });
    await ctx.engine.resume(run.id, { stage: "think" });
    await ctx.engine.pmDone(pm, run.id, { summary: "resumed on the human's answer" });
    await ctx.engine.pmTurnEnded(pm);
    expect(ctx.archived).toContain(pm);
    expect(events(ctx, run.id)).toEqual(expect.arrayContaining(["pm_escalated", "pm_escalation_timeout", "pm_answer", "pm_done"]));
  });

  it("no escalation target: straight to the human", async () => {
    const ctx = setup();
    const run = await ctx.start();
    await exhaustThink(ctx);
    const out = await ctx.engine.pmEscalate("agent-2", run.id, { question: "q?", bestGuess: "g", checked: "c" });
    expect(out).toMatchObject({ target: "human", step: 2, wait_minutes: null });
    await expect(ctx.engine.pmEscalate("agent-1", run.id, { question: "q?", bestGuess: "g", checked: "c" })).rejects.toThrow(/not the live PM/);
  });

  it("flags a PM over pm.maxUsd and handles a PM that is gone", async () => {
    const ctx = setup(flow, { pm: { maxUsd: 0.5 } });
    ctx.ports.spendOfAgent = () => 0.9;
    const run = await ctx.start();
    await exhaustThink(ctx);
    await ctx.engine.pmEscalate("agent-2", run.id, { question: "q?", bestGuess: "g", checked: "c" });
    await ctx.engine.pmTurnEnded("agent-2");
    expect(events(ctx, run.id)).toContain("pm_over_budget");
    ctx.states.set("agent-2", "gone");
    await ctx.engine.tick();
    await ctx.settle();
    expect(ctx.engine.require(run.id).pm.calls![`${run.id}:exhausted:think:1`].state).toBe("gone");
    expect([...ctx.items.values()].some((i) => /stuck at stage think/.test(i.question))).toBe(true);
  });
});

describe("decision c8125131: one free verdict reminder, the PM paged at once", () => {
  it("a turn without a verdict first gets an explicit reminder that uses no attempt, then an ordinary nudge that does", async () => {
    const ctx = setup(flow, { verdictNudge: true, pm: NO_PM });
    const run = await ctx.start();
    ctx.states.set("agent-1", "idle");
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    expect(ctx.sent.at(-1)?.text).toContain("CALL YOUR VERDICT NOW");
    expect(ctx.engine.require(run.id).stages.think.attempts).toBe(1);
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    expect(ctx.sent.at(-1)?.text).toMatch(/without giving a verdict/);
    expect(ctx.engine.require(run.id).stages.think.attempts).toBe(2);
    // the new attempt gets its own reminder before the stage is exhausted
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    expect(ctx.sent.at(-1)?.text).toContain("CALL YOUR VERDICT NOW");
    expect(ctx.engine.require(run.id).stages.think.attempts).toBe(2);
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    expect(ctx.engine.require(run.id).stages.think.status).toBe("exhausted");
  });

  it("in mail mode an exhausted stage spawns the PM at once and the mail only informs", async () => {
    const ctx = setup(flow, { runsMailTo: "@assistant", pm: { pageOnExhausted: true } }, true);
    const run = await ctx.start();
    ctx.states.set("agent-1", "idle");
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    await ctx.engine.turnEnded("agent-1", { kind: "completed" });
    await ctx.settle();
    expect(ctx.spawned.map((x) => x.role)).toEqual(["investigator", "pm"]);
    expect(ctx.engine.require(run.id).pmAgentId).toBe("agent-2");
    const mail = ctx.reports.find((r) => r.to === "@assistant" && r.subject.includes("exhausted"));
    expect(mail?.subject).toContain("PM agent-2 paged");
  });
});

describe("decision 12885996: worktree check and already-merged PRs", () => {
  const checked = flow.replace('prompt = "Investigate {{ticket}}"', 'prompt = "Investigate {{ticket}}"\nworktree_check = 30');

  it("a fresh worker whose worktree does not answer is replaced once, with a new spawn key", async () => {
    const ctx = setup(checked, { pods: true, worktree: [{ ok: false, detail: "git gave no answer (30 s)" }] });
    const run = await ctx.start();
    expect(ctx.archived).toContain("agent-1");
    expect(ctx.spawned).toHaveLength(2);
    expect(ctx.spawned[1].key).toMatch(/:w1$/);
    const live = ctx.engine.require(run.id);
    expect(live.stages.think).toMatchObject({ status: "running", agentId: "agent-2", attempts: 1 });
    expect(live.history.map((h) => h.event)).toEqual(expect.arrayContaining(["worktree_check_failed", "worktree_ok"]));
  });

  it("a second failure pauses the run instead of hanging", async () => {
    const ctx = setup(checked, { pods: true, worktree: [{ ok: false, detail: "no answer" }, { ok: false, detail: "not a git worktree: fatal" }] });
    const run = await ctx.start();
    expect(ctx.spawned.filter((x) => x.role === "investigator")).toHaveLength(2);
    expect(ctx.engine.require(run.id).status).toBe("paused");
    expect(ctx.engine.require(run.id).stages.think.summary).toContain("not a git worktree");
  });

  it("a workspace that never came up was not probed: logged, not counted, the worker keeps running", async () => {
    const ctx = setup(checked, { pods: true, worktree: [{ ok: false, unchecked: true, detail: "workspace not up after 600 s" }] });
    const run = await ctx.start();
    expect(ctx.archived).not.toContain("agent-1");
    expect(ctx.spawned).toHaveLength(1);
    const live = ctx.engine.require(run.id);
    expect(live.stages.think).toMatchObject({ status: "running", agentId: "agent-1" });
    expect(live.stages.think.worktreeFailures ?? 0).toBe(0);
    expect(live.history.map((h) => h.event)).toContain("worktree_unchecked");
  });

  it("passes worktree_boot_grace to the check, and leaves the default boot grace when it is absent", async () => {
    const graced = setup(checked.replace("worktree_check = 30", "worktree_check = 30\nworktree_boot_grace = 900"), { pods: true, worktree: [] });
    await graced.start();
    expect(graced.worktreeCalls).toEqual([{ timeoutMs: 30_000, bootMs: 900_000 }]);
    const plain = setup(checked, { pods: true, worktree: [] });
    await plain.start();
    expect(plain.worktreeCalls).toEqual([{ timeoutMs: 30_000, bootMs: undefined }]);
  });

  const merged = flow
    .replace('[stage.verify]\ndone = ["exists", "open"]\n', "")
    .replace('pr_urls_from = "build"\nmax_runs = 2', 'pr_urls_from = "build"\nmax_runs = 2\nskip_if_merged = "build"')
    .replace('pass = "land"\nfail = "repair"', 'pass = "land"\nfail = "repair"\nalready_merged = "done"');

  it("a stage whose PRs are all merged already is skipped to on.already_merged", async () => {
    const ctx = setup(merged, { pm: NO_PM });
    const run = await ctx.start(undefined, { at: "build" });
    ctx.pr[PR] = { ...okPr(PR), state: "merged" };
    await ctx.verdict("agent-1", "done", { pr_urls: [PR] });
    const live = ctx.engine.require(run.id);
    expect(live.status).toBe("done");
    expect(live.stages.check).toMatchObject({ status: "skipped", verdict: "already_merged" });
    expect(ctx.spawned.map((x) => x.role)).toEqual(["implementer"]);
  });

  it("one PR still open: the stage runs", async () => {
    const ctx = setup(merged, { pm: NO_PM });
    const run = await ctx.start(undefined, { at: "build" });
    const other = "https://github.com/acme/web/pull/9";
    ctx.pr[PR] = { ...okPr(PR), state: "merged" };
    ctx.pr[other] = okPr(other);
    await ctx.verdict("agent-1", "done", { pr_urls: [PR, other] });
    expect(ctx.engine.require(run.id).stages.check.status).toBe("running");
  });

  it("skip_if_merged needs an on.already_merged edge and a known stage", () => {
    expect(() => parseBlueprint(merged.replace('\nalready_merged = "done"', ""))).toThrow(/already_merged/);
    expect(() => parseBlueprint(merged.replace('skip_if_merged = "build"', 'skip_if_merged = "nope"'))).toThrow(/unknown stage nope/);
  });
});

describe("decision c8125131: a gate with a default answer", () => {
  const withDefault = flow.replace('question = "Merge?"', 'question = "Merge?"\nexpires_in_minutes = 60\ndefault_answer = "merged"');

  it("takes the default answer when its Inbox item expires", async () => {
    const ctx = setup(withDefault, { pm: NO_PM });
    const run = await ctx.start(undefined, { at: "land" });
    const itemId = [...ctx.items.keys()].at(-1)!;
    ctx.items.get(itemId)!.gate = { status: "expired", optionId: null, text: null, by: null };
    await ctx.engine.gateResolved(itemId);
    await ctx.settle();
    const live = ctx.engine.require(run.id);
    expect(live.status).toBe("done");
    expect(live.stages.land).toMatchObject({ verdict: "merged" });
    expect(live.history.find((h) => h.event === "gate_answered")?.detail).toContain("by default");
  });

  it("needs expires_in_minutes and an edge", () => {
    expect(() => parseBlueprint(withDefault.replace("expires_in_minutes = 60\n", ""))).toThrow(/default_answer needs expires_in_minutes/);
    expect(() => parseBlueprint(withDefault.replace('default_answer = "merged"', 'default_answer = "nope"'))).toThrow(/has no edge/);
  });
});

describe("abort (decision 2d22d545)", () => {
  const parentSrc = `
version = 1
name = "parent"
[[stage]]
id = "hand"
kind = "blueprint"
blueprint = "kid"
[stage.on]
done = "after"
failed = "mark-failed"
aborted = "mark-failed"
[[stage]]
id = "after"
role = "implementer"
prompt = "After"
[stage.on]
done = "done"
[[stage]]
id = "mark-failed"
role = "implementer"
prompt = "Mark failed"
[stage.on]
done = "failed"
`;
  const grandSrc = `
version = 1
name = "grand"
[[stage]]
id = "hand"
kind = "blueprint"
blueprint = "parent"
[stage.on]
done = "done"
failed = "mark-failed"
aborted = "mark-failed"
[[stage]]
id = "mark-failed"
role = "implementer"
prompt = "Mark failed"
[stage.on]
done = "failed"
`;
  const kidSrc = `
version = 1
name = "kid"
[[stage]]
id = "work"
role = "implementer"
prompt = "Work"
[stage.on]
done = "done"
bad = "failed"
`;
  function family() {
    const ctx = setup();
    const srcs: Record<string, string> = { grand: grandSrc, parent: parentSrc, kid: kidSrc };
    ctx.ports.blueprint = (name) => (srcs[name] ? parseBlueprint(srcs[name]) : undefined);
    const children = (id: string) => ctx.store.all().filter((r) => r.parent?.runId === id);
    return { ctx, children };
  }
  const entered = (run: { history: { event: string }[] }) => run.history.filter((e) => e.event === "transition");

  it("a parent aborted while its child waits stays aborted when the child then finishes done", async () => {
    const { ctx, children } = family();
    const run = ctx.engine.start({ blueprint: "parent", vars: {}, requestedBy: "x" });
    await ctx.settle();
    const child = children(run.id)[0]!;
    expect(ctx.engine.require(run.id).stages.hand.status).toBe("waiting");
    // Aborted before abort cascaded (or by any path that leaves the child running): only the parent ended.
    const p = ctx.engine.require(run.id);
    p.status = "aborted";
    p.endedAt = 1;
    ctx.store.save();
    const before = entered(p).length;
    await ctx.verdict("agent-1", "done");
    expect(ctx.engine.require(child.id).status).toBe("done");
    expect(ctx.engine.require(run.id).status).toBe("aborted");
    expect(entered(ctx.engine.require(run.id))).toHaveLength(before);
    expect(ctx.spawned).toHaveLength(1);
  });

  it("aborting a parent aborts its waiting child; the child's end enters no on.* stage of the parent", async () => {
    const { ctx, children } = family();
    const run = ctx.engine.start({ blueprint: "parent", vars: {}, requestedBy: "x" });
    await ctx.settle();
    const child = children(run.id)[0]!;
    const before = entered(ctx.engine.require(run.id)).length;
    await ctx.engine.abort(run.id, "stop");
    await ctx.settle();
    expect(ctx.engine.require(child.id)).toMatchObject({ status: "aborted", error: `parent run ${run.id} aborted: stop` });
    expect(ctx.engine.require(run.id)).toMatchObject({ status: "aborted", error: "stop", stage: "hand" });
    expect(entered(ctx.engine.require(run.id))).toHaveLength(before);
    expect(ctx.spawned).toHaveLength(1);
    // A late verdict of the child's worker changes nothing.
    await ctx.engine.verdict("agent-1", { verdict: "done", data: {}, summary: "" }).catch(() => undefined);
    await ctx.settle();
    expect(ctx.engine.require(run.id).status).toBe("aborted");
    expect(ctx.engine.require(child.id).status).toBe("aborted");
  });

  it("cascades to grandchildren", async () => {
    const { ctx, children } = family();
    const run = ctx.engine.start({ blueprint: "grand", vars: {}, requestedBy: "x" });
    await ctx.settle();
    const mid = children(run.id)[0]!;
    const kid = children(mid.id)[0]!;
    expect(kid.blueprint).toBe("kid");
    await ctx.engine.abort(run.id, "stop");
    await ctx.settle();
    expect(ctx.engine.require(run.id).status).toBe("aborted");
    expect(ctx.engine.require(mid.id)).toMatchObject({ status: "aborted", error: `parent run ${run.id} aborted: stop` });
    expect(ctx.engine.require(kid.id)).toMatchObject({ status: "aborted", error: `parent run ${mid.id} aborted: parent run ${run.id} aborted: stop` });
    expect(ctx.spawned).toHaveLength(1);
  });

  it("stops (archives) a mid-turn stage worker, but never the caller", async () => {
    const a = setup();
    const run = await a.start();
    expect(a.states.get("agent-1")).toBe("running");
    await a.engine.abort(run.id, "stop");
    expect(a.archived).toContain("agent-1");
    expect(a.engine.require(run.id).history.some((e) => e.event === "worker_stopped")).toBe(true);

    const b = setup();
    const own = await b.start();
    await b.engine.abort(own.id, "stop", { by: "agent-1" });
    expect(b.archived).not.toContain("agent-1");
    expect(b.engine.require(own.id).history.some((e) => e.event === "worker_stopped")).toBe(false);
  });
});

describe("without Agents Mail", () => {
  const exhaustThink = async (ctx: ReturnType<typeof setup>) => {
    for (let i = 0; i < 4; i++) {
      await ctx.engine.turnEnded("agent-1", { kind: "completed" });
      await ctx.settle();
    }
  };
  const pms = (ctx: ReturnType<typeof setup>) => ctx.spawned.filter((s) => s.role === "pm");

  it("runs.notifyMailTo is ignored: the PM is spawned and the starter is told, as when it is unset", async () => {
    const ctx = setup(flow, { runsMailTo: "@assistant" }, true);
    ctx.ports.mailUp = () => false;
    const run = await ctx.start(undefined, { ownerAgentId: "pm-agent" });
    await exhaustThink(ctx);
    expect(ctx.engine.require(run.id).status).toBe("waiting");
    expect(pms(ctx)).toHaveLength(1);
    expect(ctx.reports.filter((r) => r.to === "@assistant")).toHaveLength(0);
    await ctx.engine.abort(run.id, "stop");
    expect(ctx.reports.map((r) => r.to)).toEqual(["pm-agent"]);
  });

  it("with Agents Mail up, runs.notifyMailTo works as before", async () => {
    const ctx = setup(flow, { runsMailTo: "@assistant" }, true);
    ctx.ports.mailUp = () => true;
    const run = await ctx.start(undefined, { ownerAgentId: "pm-agent" });
    await exhaustThink(ctx);
    expect(pms(ctx)).toHaveLength(0);
    expect(ctx.reports.map((r) => r.subject)).toEqual([`Run ${run.id} ABC-1 needs PM`]);
  });

  it("a PM escalation target that needs a mail is skipped: the human is asked at once, with no timeout to wait", async () => {
    const ctx = setup(flow, { escalationTarget: "@ops" });
    ctx.ports.mailUp = () => false;
    const run = await ctx.start();
    await exhaustThink(ctx);
    const pm = pms(ctx).length ? ctx.engine.require(run.id).pm.calls![`${run.id}:exhausted:think:1`].agentId! : "";
    const out = await ctx.engine.pmEscalate(pm, run.id, { question: "q?", bestGuess: "g", checked: "c" });
    expect(out).toMatchObject({ target: "human", step: 2, wait_minutes: null });
    expect(out.how).toContain("inbox_ask");
    expect(out.how).not.toContain("mail_send");
    expect(ctx.engine.require(run.id).history.map((h) => h.event)).toContain("pm_escalation_skipped");
  });

  it("the Supervisor is still asked first (no mail needed), and a mail target is asked by mail when Mail is up", async () => {
    const sup = setup(flow, { escalationTarget: "supervisor" });
    sup.ports.mailUp = () => false;
    const r1 = await sup.start();
    await exhaustThink(sup);
    const pm1 = sup.engine.require(r1.id).pm.calls![`${r1.id}:exhausted:think:1`].agentId!;
    expect(await sup.engine.pmEscalate(pm1, r1.id, { question: "q?", bestGuess: "g", checked: "c" })).toMatchObject({ target: "supervisor", step: 1 });

    const mail = setup(flow, { escalationTarget: "@ops" });
    mail.ports.mailUp = () => true;
    const r2 = await mail.start();
    await exhaustThink(mail);
    const pm2 = mail.engine.require(r2.id).pm.calls![`${r2.id}:exhausted:think:1`].agentId!;
    const out = await mail.engine.pmEscalate(pm2, r2.id, { question: "q?", bestGuess: "g", checked: "c" });
    expect(out).toMatchObject({ target: "@ops", step: 1, wait_minutes: 30 });
    expect(out.how).toContain("mail_send");
  });
});

describe("a stage kind no extension provides is refused at start", () => {
  const src = `
version = 1
name = "flow"
[[stage]]
id = "pins"
kind = "train"
[stage.on]
ok = "done"
`;

  it("refuses the run with a clear error, and creates nothing", () => {
    const ctx = setup(src);
    ctx.ports.stageKindKnown = () => false;
    expect(() => ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" })).toThrow(/stage "pins" has kind "train", and no installed extension provides it/);
    expect(ctx.store.all()).toHaveLength(0);
  });

  it("starts when an extension provides it now, or did lately (it may be restarting)", async () => {
    const now = setup(src);
    now.ports.stageKindKnown = () => false;
    now.ports.stageKind = () => async () => ({ verdict: "ok" });
    const r1 = now.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await now.settle();
    expect(now.engine.require(r1.id).status).toBe("done");

    const away = setup(src);
    away.ports.stageKindKnown = (kind) => kind === "train";
    const r2 = away.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await away.settle();
    expect(away.engine.require(r2.id).waitingFor).toContain('extension for stage kind "train"');
  });

  it("checks the stages of a child blueprint too", () => {
    const ctx = setup(`
version = 1
name = "flow"
[[stage]]
id = "child"
kind = "blueprint"
blueprint = "release"
[stage.on]
done = "done"
`);
    const child = parseBlueprint(src.replace('name = "flow"', 'name = "release"'));
    const own = ctx.ports.blueprint;
    ctx.ports.blueprint = (name) => (name === "release" ? child : own(name));
    ctx.ports.stageKindKnown = () => false;
    expect(() => ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" })).toThrow(/stage "child > pins" has kind "train"/);
  });
});
