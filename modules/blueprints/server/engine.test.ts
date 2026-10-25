import { describe, expect, it } from "vitest";
import { Engine, UsageError, type GateState, type PrFacts, type Ports } from "./engine";
import { RunStore } from "./store";
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

function setup(source = flow) {
  let time = 1_000_000;
  const spawned: { role: string; prompt: string; labels: Record<string, string>; env: Record<string, string>; key: string }[] = [];
  const sent: { to: string; text: string }[] = [];
  const states = new Map<string, "running" | "idle" | "gone">();
  const items = new Map<string, { gate: GateState; question: string; withdrawn: string | null }>();
  const pr: Record<string, PrFacts> = {};
  const wardens: string[] = [];
  const archived: string[] = [];
  const store = new RunStore(null);
  let agents = 0;
  const ports: Ports = {
    now: () => time,
    async spawn(o) {
      const agentId = `agent-${++agents}`;
      spawned.push({ role: o.role, prompt: o.prompt, labels: o.labels, env: o.env, key: o.idempotencyKey });
      states.set(agentId, "running");
      return { agentId };
    },
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
    tool: () => null,
    stageKind: () => null,
    blueprint: (name) => (name === "flow" ? parseBlueprint(source) : undefined),
    settings: () => ({ defaultCwd: "/w", pmRole: "pm", idleGraceSeconds: 90, archiveOnFinish: false }),
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
  const start = async (vars: Record<string, string> = { ticket: "ANY-1", ticket_confirmed: "true" }, extra: Record<string, unknown> = {}) => {
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
  return { engine, store, spawned, sent, states, items, pr, wardens, archived, start, verdict, answer, settle, advance: (ms: number) => (time += ms), ports };
}

const okPr = (url: string, head = "abc123"): PrFacts => ({ url, exists: true, state: "open", head, ci: "green", mergeable: true, draft: false, review: "" });
const PR = "https://github.com/acme/api/pull/7";

describe("starting", () => {
  it("needs the confirmed ticket and checks the pattern", () => {
    const { engine } = setup();
    expect(() => engine.start({ blueprint: "flow", vars: { ticket: "ANY-1" }, requestedBy: "x" })).toThrow(/confirmed/);
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
    expect(spawned[0].prompt).toContain("Investigate ANY-1");
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
    await expect(engine.verdict("agent-1", { verdict: "done", data: { pr_urls: [PR] } })).rejects.toThrow(/closed, not open/);
    pr[PR] = okPr(PR);
    await verdict("agent-1", "done", { pr_urls: [PR] });
    expect(engine.require(run.id).stage).toBe("check");
  });

  it("gives PR stages the GitHub facts in their prompt", async () => {
    const { start, verdict, pr, spawned } = setup();
    pr[PR] = okPr(PR, "abc123def456");
    await start(undefined, { at: "build" });
    await verdict("agent-1", "done", { pr_urls: [PR] });
    const qa = spawned.find((s) => s.role === "qa")!;
    expect(qa.prompt).toMatch(/GitHub facts/);
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

  it("exhaustion hands ONE judgement to the PM, who can grant bounded extra attempts", async () => {
    const { run, engine, sent } = await exhaust();
    expect(engine.require(run.id)).toMatchObject({ status: "waiting", pm: { pending: { stage: "think" } } });
    expect(sent.some((m) => m.to === "pm-agent" && /ONE judgement/.test(m.text))).toBe(true);
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
    expect(items.get("item-1")?.question).toMatch(/Criteria for ANY-1/);
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

  it("skip_if follows the skipped edge", async () => {
    const { start, verdict, engine } = setup();
    const run = await start({ ticket: "ANY-2", ticket_confirmed: "true", bump: "true" });
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
tool = "releaser_join"
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
    ctx.ports.tool = (name) => (name === "releaser_join" ? async (args) => (calls.push(args), "joined") : null);
    const run = ctx.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await ctx.settle();
    expect(calls).toEqual([{ service: "backend", list: [] }]);
    expect(ctx.engine.require(run.id).status).toBe("done");
    void parent;
  });
});
