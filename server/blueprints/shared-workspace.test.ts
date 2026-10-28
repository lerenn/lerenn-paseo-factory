import { describe, expect, it } from "vitest";
import { Engine, type Ports } from "./engine";
import { RunStore } from "./store";
import { parseBlueprint } from "./toml";
import { spawnAgent } from "../spawn-agent";
import { vi } from "vitest";

const flow = `
version = 1
name = "flow"
[[stage]]
id = "think"
role = "investigator"
workspace = "run"
prompt = "think"
[stage.on]
ok = "build"
[[stage]]
id = "build"
role = "implementer"
workspace = "run"
prompt = "build"
[stage.on]
done = "check"
[[stage]]
id = "check"
role = "qa"
prompt = "check"
[stage.on]
pass = "watch"
fail = "repair"
[[stage]]
id = "repair"
role = "implementer"
agent = "reuse:build"
workspace = "run"
prompt = "repair"
[stage.on]
done = "check"
[[stage]]
id = "watch"
role = "pr-babysitter"
workspace = "run"
prompt = "watch"
[stage.on]
ready = "done"
`;

function setup(share: boolean, probe: "clean" | "dirty" = "clean") {
  const spawned: { role: string; join?: string }[] = [];
  const archived: string[] = [];
  const archivedWs: string[] = [];
  const probes: string[] = [];
  const states = new Map<string, "running" | "idle" | "gone">();
  let n = 0;
  const ports: Ports = {
    now: () => 1,
    async spawn(o) {
      const agentId = `agent-${++n}`;
      spawned.push({ role: o.role, join: o.joinWorkspaceId });
      states.set(agentId, "running");
      return { agentId, workspaceId: o.joinWorkspaceId ?? `ws-${n}` };
    },
    async send() {},
    async agentState(id) {
      return states.get(id) ?? "gone";
    },
    async archive(id) {
      archived.push(id);
    },
    async archiveWorkspace(id) {
      archivedWs.push(id);
    },
    async worktree(id) {
      probes.push(id);
      return { state: probe, detail: "1 uncommitted file(s)" };
    },
    ask: () => ({ itemId: "i" }),
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
    settings: () => ({ defaultCwd: "/w", pmRole: "pm", idleGraceSeconds: 90, archiveOnFinish: false, shareWorkspace: share }),
    post: () => ({ eventsMailTo: "", retro: { enabled: false, mailTo: "@user", role: "retro", maxUsd: 1, timeoutMinutes: 10, skipTrivial: true }, janitor: { enabled: true, dryRun: false } }),
  };
  const engine = new Engine(new RunStore(null), ports);
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  const verdict = async (agent: string, v: string) => {
    await engine.verdict(agent, { verdict: v });
    await settle();
  };
  return { engine, spawned, archived, archivedWs, probes, states, settle, verdict, ports };
}

async function walk(t: ReturnType<typeof setup>) {
  const run = t.engine.start({ blueprint: "flow", vars: {}, requestedBy: "x" });
  await t.settle();
  await t.verdict("agent-1", "ok"); // think -> build
  await t.verdict("agent-2", "done"); // build -> check
  await t.verdict("agent-3", "fail"); // check -> repair (same implementer, same pod)
  await t.verdict("agent-2", "done"); // repair -> check
  await t.verdict("agent-4", "pass"); // check (a re-entered stage gets a fresh worker and pod) -> watch
  return run;
}

describe("shared workspace per run", () => {
  it("investigate, implement and babysit share one workspace; QA gets its own", async () => {
    const t = setup(true);
    const run = await walk(t);
    expect(t.spawned).toEqual([
      { role: "investigator", join: undefined },
      { role: "implementer", join: "ws-1" },
      { role: "qa", join: undefined },
      { role: "qa", join: undefined },
      { role: "pr-babysitter", join: "ws-1" },
    ]);
    expect(t.engine.require(run.id).sharedWorkspaceId).toBe("ws-1");
    expect(Object.values(t.engine.require(run.id).agents!).map((a) => a.workspaceId)).toEqual(["ws-1", "ws-1", "ws-3", "ws-4", "ws-1"]);
  });

  it("with the flag off every worker gets its own workspace, as before", async () => {
    const t = setup(false);
    await walk(t);
    expect(t.spawned.every((s) => s.join === undefined)).toBe(true);
  });

  it("the janitor inspects the shared pod once and archives it after all its agents; QA's pod separately", async () => {
    const t = setup(true);
    await walk(t);
    await t.verdict("agent-5", "ready");
    expect(t.probes.sort()).toEqual(["ws-1", "ws-3", "ws-4"]); // the shared pod once, not once per agent
    expect(t.archived.sort()).toEqual(["agent-1", "agent-2", "agent-3", "agent-4", "agent-5"]);
    expect(t.archivedWs.sort()).toEqual(["ws-1", "ws-3", "ws-4"]);
  });

  it("a dirty shared pod is kept with all its agents while QA's clean pod goes", async () => {
    const t = setup(true);
    t.ports.worktree = async (id) => (id === "ws-1" ? { state: "dirty", detail: "2 uncommitted file(s)" } : { state: "clean", detail: "clean" });
    await walk(t);
    await t.verdict("agent-5", "ready");
    expect(t.archivedWs.sort()).toEqual(["ws-3", "ws-4"]);
    expect(t.archived.sort()).toEqual(["agent-3", "agent-4"]);
  });
});

describe("spawnAgent joining a workspace", () => {
  it("creates the agent in the existing workspace instead of a new pod", async () => {
    const agentCreate = vi.fn(async (_a: unknown) => ({ id: "ag-join" }));
    const wsCreate = vi.fn();
    const ref = vi.fn(() => ({ agents: { create: agentCreate } }));
    const out = await spawnAgent({ workspaces: { create: wsCreate, ref } } as never, "kubernetes", {
      idempotencyKey: "r:build:1:1",
      config: { provider: "claude/x" },
      cwd: "/repo",
      title: "t",
      workspaceTitle: "w",
      prompt: "p",
      labels: {},
      env: {},
      joinWorkspaceId: "ws-1",
    });
    expect(out).toEqual({ agentId: "ag-join", workspaceId: "ws-1" });
    expect(ref).toHaveBeenCalledWith("ws-1");
    expect(wsCreate).not.toHaveBeenCalled();
  });
});
