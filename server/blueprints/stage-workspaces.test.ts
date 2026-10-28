import { describe, expect, it, vi } from "vitest";
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

function setup(over: { janitor?: boolean; trace?: string | "hang" } = {}) {
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
    async trace() {
      return over.trace === "hang" ? new Promise<string>(() => undefined) : (over.trace ?? "clean");
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

  it("archives a dirty workspace too, and records what was in it", async () => {
    const dirty = setup({ trace: "2 entries: M a.ts; ?? b.ts" });
    const dirtyRun = dirty.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await dirty.settle();
    await dirty.verdict("agent-1", "done");
    await dirty.verdict("agent-2", "fail");
    expect(dirty.archived).toEqual(["agent-2"]);
    expect(dirty.archivedWs).toEqual(["ws-2"]);
    const entry = dirty.engine.require(dirtyRun.id).history.find((h) => h.event === "workspace_archived");
    expect(entry?.detail).toContain("M a.ts");
    expect(dirty.engine.require(dirtyRun.id).history.some((h) => h.event === "workspace_kept")).toBe(false);
  });

  it("leaves a workspace another live agent is in (the sweep takes it later)", async () => {
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
    expect(isBusyError("Git command timed out after 90000ms: git rev-parse --show-toplevel")).toBe(true);
    expect(isBusyError("exceeded quota")).toBe(false);
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

describe("orphan sweep", () => {
  it("archives a worker no stage refers to, keeps the current one, and leaves a dirty workspace alone for hours", async () => {
    const t = setup();
    const run = t.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await t.settle();
    const live = t.engine.require(run.id);
    (live.agents ??= {})["old-1"] = { role: "implementer", stage: "build", workspaceId: "ws-old" };
    t.states.set("old-1", "idle");
    expect(await t.engine.sweepOrphans()).toEqual(["old-1", "ws-old"]);
    expect(t.archived).toEqual(["old-1"]);
    expect(t.archivedWs).toEqual(["ws-old"]);
    expect(t.engine.require(run.id).history.some((h) => h.event === "orphan_archived")).toBe(true);
    expect(await t.engine.sweepOrphans()).toEqual([]); // the current worker (agent-1) stays
  });

  it("keeps a mid-turn orphan, archives a dirty one at once, and never touches the PM", async () => {
    const t = setup({ trace: "1 entries: M a.ts" });
    const run = t.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await t.settle();
    const live = t.engine.require(run.id);
    live.pmAgentId = "pm-1";
    live.agents!["pm-1"] = { role: "pm", stage: "pm", workspaceId: "ws-pm" };
    live.agents!["busy"] = { role: "qa", stage: "check", workspaceId: "ws-busy" };
    live.agents!["dirty"] = { role: "qa", stage: "check", workspaceId: "ws-dirty" };
    t.states.set("pm-1", "idle");
    t.states.set("busy", "running");
    t.states.set("dirty", "idle");
    await t.engine.sweepOrphans();
    expect(t.archived).toEqual(["dirty"]);
    expect(t.archivedWs).toEqual(["ws-dirty"]);
    expect(t.engine.require(run.id).history.some((h) => h.event === "workspace_kept")).toBe(false);
  });

  it("archives the workers of an ended run at once, and not a retro that is still writing", async () => {
    const t = setup();
    const run = t.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await t.settle();
    const live = t.engine.require(run.id);
    live.agents!["old"] = { role: "qa", stage: "check", workspaceId: "ws-old" };
    live.agents!["retro-1"] = { role: "retro", stage: "retro", workspaceId: "ws-retro" };
    live.endedAt = 1_000_000;
    live.post = { phase: "retro", retro: { agentId: "retro-1", startedAt: 1_000_000 } } as never;
    t.states.set("old", "idle");
    t.states.set("retro-1", "idle");
    await t.engine.sweepOrphans();
    expect(t.archivedWs).toEqual(["ws-1", "ws-old"]);
    live.post = { phase: "done" } as never;
    await t.engine.sweepOrphans();
    expect(t.archivedWs).toEqual(["ws-1", "ws-old", "ws-retro"]);
  });
});

describe("worktree trace of a retired worker", () => {
  it("never blocks the archive: a pod that does not answer is archived anyway", async () => {
    const t = setup({ trace: "hang" });
    const run = t.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
    await t.settle();
    t.engine.require(run.id).agents!["old"] = { role: "qa", stage: "check", workspaceId: "ws-old" };
    t.states.set("old", "idle");
    vi.useFakeTimers();
    try {
      const swept = t.engine.sweepOrphans();
      await vi.advanceTimersByTimeAsync(5_000);
      await swept;
    } finally {
      vi.useRealTimers();
    }
    expect(t.archivedWs).toEqual(["ws-old"]);
    expect(t.engine.require(run.id).history.find((h) => h.event === "workspace_archived")?.detail).toContain("no answer");
  });
});
