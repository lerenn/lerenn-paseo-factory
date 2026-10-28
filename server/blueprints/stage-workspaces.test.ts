import { describe, expect, it } from "vitest";
import { Engine, type Ports } from "./engine";
import { isBusyError, isQuotaError, MAX_BUSY_RETRIES, quotaBackoffMs } from "./flake";
import { RunStore } from "./store";
import { parseBlueprint } from "./toml";

const flow = `
version = 1
name = "flow"
[[stage]]
id = "build"
role = "implementer"
prompt = "build"
[stage.on]
done = "check"
[[stage]]
id = "check"
role = "qa"
prompt = "check"
[stage.on]
pass = "done"
fail = "repair"
[[stage]]
id = "repair"
role = "implementer"
agent = "reuse:build"
prompt = "repair"
[stage.on]
done = "check"
`;

const QUOTA = "exceeded quota: agents, requested: count/sandboxes.agents.x-k8s.io=1, used: count/sandboxes.agents.x-k8s.io=24, limited: count/sandboxes.agents.x-k8s.io=24";

function setup(over: { janitor?: boolean; probe?: "clean" | "dirty" } = {}) {
  let now = 1_000_000;
  let n = 0;
  const spawned: string[] = [];
  const archived: string[] = [];
  const archivedWs: string[] = [];
  const asked: string[] = [];
  const states = new Map<string, "running" | "idle" | "gone">();
  const failures: string[] = [];
  const ports: Ports = {
    now: () => now,
    async spawn(o) {
      const failure = failures.shift();
      if (failure) throw new Error(failure);
      const agentId = `agent-${++n}`;
      spawned.push(`${o.role}:${agentId}`);
      states.set(agentId, "idle");
      return { agentId, workspaceId: `ws-${n}` };
    },
    async send() {},
    async agentState(id) {
      return states.get(id) ?? "gone";
    },
    async archive(id) {
      archived.push(id);
      states.delete(id);
    },
    async archiveWorkspace(id) {
      archivedWs.push(id);
    },
    async worktree() {
      return { state: over.probe ?? "clean", detail: "1 uncommitted file(s)" };
    },
    ask: (o) => {
      asked.push(o.question);
      return { itemId: "i" };
    },
    gate: () => null,
    withdraw() {},
    wardenRegister: () => null,
    wardenDone() {},
    async prFacts(url) {
      return { url, exists: true, state: "open", head: "a", ci: "green", mergeable: true, draft: false, review: "" };
    },
    tool: () => null,
    stageKind: () => null,
    blueprint: () => parseBlueprint(flow),
    settings: () => ({ defaultCwd: "/w", pmRole: "pm", idleGraceSeconds: 90, archiveOnFinish: false }),
    post: () => ({ eventsMailTo: "", retro: { enabled: false, mailTo: "@user", role: "retro", maxUsd: 1, timeoutMinutes: 10, skipTrivial: true }, janitor: { enabled: !!over.janitor, dryRun: false } }),
  };
  const engine = new Engine(new RunStore(null), ports);
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  const verdict = async (agent: string, v: string) => {
    await engine.verdict(agent, { verdict: v });
    await settle();
  };
  return { engine, spawned, archived, archivedWs, asked, states, failures, settle, verdict, advance: (ms: number) => (now += ms) };
}

describe("workspaces of finished stage workers", () => {
  it("a finished stage's worker and workspace are archived once the run moves on; a reused worker is kept", async () => {
    const t = setup();
    const run = t.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await t.settle();
    await t.verdict("agent-1", "done"); // build -> check (repair may reuse build)
    expect(t.archived).toEqual([]);
    await t.verdict("agent-2", "fail"); // check -> repair: reuses agent-1; agent-2 is done
    expect(t.archived).toEqual(["agent-2"]);
    expect(t.archivedWs).toEqual(["ws-2"]);
    await t.verdict("agent-1", "done"); // repair -> check: a fresh qa
    await t.verdict("agent-3", "pass"); // -> done: everything else goes
    expect(t.engine.require(run.id).status).toBe("done");
    expect(t.archived.sort()).toEqual(["agent-1", "agent-2", "agent-3"]);
    expect(t.archivedWs.sort()).toEqual(["ws-1", "ws-2", "ws-3"]);
  });

  it("a worker still mid-turn is archived, with its workspace, when its turn ends", async () => {
    const t = setup();
    t.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await t.settle();
    await t.verdict("agent-1", "done");
    t.states.set("agent-2", "running");
    await t.verdict("agent-2", "fail"); // agent-2 is still in its turn
    expect(t.archived).toEqual([]);
    t.states.set("agent-2", "idle");
    await t.engine.turnEnded("agent-2", { kind: "completed" });
    expect(t.archived).toEqual(["agent-2"]);
    expect(t.archivedWs).toEqual(["ws-2"]);
  });

  it("keeps the workspace when its worktree is dirty or another live agent is in it", async () => {
    const dirty = setup({ probe: "dirty" });
    dirty.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await dirty.settle();
    await dirty.verdict("agent-1", "done");
    await dirty.verdict("agent-2", "fail");
    expect(dirty.archived).toEqual(["agent-2"]);
    expect(dirty.archivedWs).toEqual([]);

    const busy = setup();
    busy.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await busy.settle();
    (busy.engine as unknown as { ports: Ports }).ports.liveAgentsIn = async () => ["agent-2", "someone-else"];
    await busy.verdict("agent-1", "done");
    await busy.verdict("agent-2", "fail");
    expect(busy.archivedWs).toEqual([]);
  });

  it("an aborted run archives its workers' workspaces, unless the janitor does it", async () => {
    const t = setup();
    const run = t.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await t.settle();
    await t.engine.abort(run.id, "stop");
    await t.settle();
    expect(t.archived).toEqual(["agent-1"]);
    expect(t.archivedWs).toEqual(["ws-1"]);

    const j = setup({ janitor: true });
    const run2 = j.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await j.settle();
    await j.engine.abort(run2.id, "stop");
    await j.settle();
    expect(j.engine.require(run2.id).history.some((h) => h.event === "workspace_archived")).toBe(false); // the janitor's job after the retro
  });
});

describe("quota refusals", () => {
  it("recognizes them and backs off 1, 2, 4, 8, 8 minutes", () => {
    expect(isQuotaError(QUOTA)).toBe(true);
    expect(isQuotaError("pod not ready")).toBe(false);
    expect([1, 2, 3, 4, 5, 9].map(quotaBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, 480_000, 480_000]);
  });

  it("a start refused for quota uses no attempt, raises no inbox item and is retried by the tick with back-off", async () => {
    const t = setup();
    t.failures.push(QUOTA, QUOTA);
    const run = t.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await t.settle();
    let r = t.engine.require(run.id);
    expect(r.status).toBe("running");
    expect(r.stages.build).toMatchObject({ status: "entering", attempts: 0, flakes: 0 });
    expect(r.history.some((h) => h.event === "quota_wait" && /no attempt used, retry 1 in 1 min/.test(h.detail ?? ""))).toBe(true);
    expect(t.asked).toEqual([]);

    await t.engine.tick(); // too early
    expect(t.spawned).toEqual([]);
    t.advance(60_000);
    await t.engine.tick(); // second refusal: waits 2 minutes
    await t.settle();
    r = t.engine.require(run.id);
    expect(r.stages.build.quotaRetry?.n).toBe(2);
    t.advance(60_000);
    await t.engine.tick();
    expect(t.spawned).toEqual([]);
    t.advance(60_000);
    await t.engine.tick();
    await t.settle();
    r = t.engine.require(run.id);
    expect(t.spawned).toEqual(["implementer:agent-1"]);
    expect(r.stages.build).toMatchObject({ status: "running", attempts: 1, quotaRetry: null });
    expect(t.asked).toEqual([]);
  });

  it("a start that timed out on a busy daemon is retried with back-off, then pauses after MAX_BUSY_RETRIES", async () => {
    const BUSY = "Plugin kubernetes-runtime workspace.create.before failed: Plugin RPC timed out: kubernetes-runtime.hook";
    expect(isBusyError(BUSY)).toBe(true);
    const t = setup();
    for (let i = 0; i <= MAX_BUSY_RETRIES; i++) t.failures.push(BUSY);
    const run = t.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await t.settle();
    let r = t.engine.require(run.id);
    expect(r.history.some((h) => h.event === "busy_wait")).toBe(true);
    expect(r.stages.build.summary).toMatch(/daemon is busy/);
    expect(t.asked).toEqual([]);
    for (let i = 0; i < MAX_BUSY_RETRIES; i++) {
      t.advance(8 * 60_000);
      await t.engine.tick();
      await t.settle();
    }
    r = t.engine.require(run.id);
    expect(r.status).toBe("paused");
    expect(r.stages.build.attempts).toBe(0);
  });
});
