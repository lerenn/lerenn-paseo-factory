import { describe, expect, it } from "vitest";
import { buildGraph, layerStages, NODE_H, NODE_W } from "./graph";
import type { StageDetail } from "./rpc";
import type { RunView } from "./run";

const base = { title: null, role: null, agent: "new", verdicts: [], maxAttempts: 3, maxRuns: null, flakeRetries: null, skipIf: null, facts: null, verify: {}, gate: null, tool: null, childBlueprint: null, usesLease: false };
const stage = (id: string, on: Record<string, string>, over: Partial<StageDetail> = {}): StageDetail => ({ ...base, id, kind: "agent", role: id, on, ...over });

const details: StageDetail[] = [
  stage("implement", { done: "qa", blocked: "ask", exhausted: "pm" }),
  stage("qa", { pass: "babysit", needs_fix: "implement" }),
  stage("ask", { answered: "implement" }, { kind: "gate", role: null }),
  stage("babysit", { ready: "done", needs_fix: "implement" }, { kind: "blueprint", childBlueprint: "babysit-pr" }),
];

const stageView = (id: string, status: string, over = {}) => ({ id, kind: "agent", role: id, status, runs: 1, attempts: 1, maxAttempts: 3, maxRuns: null, agentId: null, verdict: null, summary: null, ...over });
const ev = (at: number, event: string, stage: string | null, detail: string | null = null) => ({ at, event, stage, detail });

describe("layering", () => {
  it("puts stages in columns by longest path and treats loops as back edges", () => {
    const { layer, back } = layerStages(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"], ["a", "c"]]);
    expect([layer.get("a"), layer.get("b"), layer.get("c")]).toEqual([0, 1, 2]);
    expect([...back]).toEqual(["c>a"]);
  });
});

describe("static shape", () => {
  const g = buildGraph(details);
  it("has a node per stage plus done and the PM", () => {
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["ask", "babysit", "done", "implement", "pm", "qa"]);
    expect(g.nodes.every((n) => n.state === "static" && n.visited)).toBe(true);
    expect(g.nodes.find((n) => n.id === "babysit")!.childBlueprint).toBe("babysit-pr");
  });
  it("has an edge per verdict, loops marked back and routed under the nodes", () => {
    expect(g.edges).toHaveLength(8);
    const loops = g.edges.filter((e) => e.back).map((e) => `${e.from}>${e.to}`).sort();
    expect(loops).toEqual(["ask>implement", "babysit>implement", "qa>implement"]);
    const bottom = Math.max(...g.nodes.map((n) => n.y + n.h));
    for (const e of g.edges.filter((x) => x.back)) expect(Math.max(...e.points.map((p) => p.y))).toBeGreaterThan(bottom);
    expect(g.height).toBeGreaterThan(bottom);
  });
  it("never overlaps two nodes and keeps edges axis-aligned", () => {
    for (const a of g.nodes) for (const b of g.nodes) if (a.id < b.id) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    for (const e of g.edges) e.points.slice(1).forEach((p, i) => expect(p.x === e.points[i].x || p.y === e.points[i].y).toBe(true));
    expect(g.nodes.find((n) => n.id === "implement")!.w).toBe(NODE_W);
    expect(g.nodes.find((n) => n.id === "implement")!.h).toBe(NODE_H);
  });
});

describe("with a run", () => {
  const run = {
    id: "bp-1",
    blueprint: "ticket",
    status: "running",
    stage: "implement",
    vars: {},
    requestedBy: "x",
    createdAt: 0,
    updatedAt: 0,
    endedAt: null,
    error: null,
    waitingFor: null,
    pmPending: null,
    parent: null,
    stages: [stageView("implement", "running", { attempts: 3, runs: 2, agentId: "ag1" }), stageView("qa", "done"), stageView("ask", "pending"), stageView("babysit", "pending")],
    history: [ev(10, "enter", "implement"), ev(20, "verdict", "implement", "done: x"), ev(21, "enter", "qa"), ev(30, "verdict", "qa", "needs_fix: y"), ev(31, "enter", "implement")],
  } as unknown as RunView;
  const g = buildGraph(details, run);
  it("highlights the current stage with state, retries and agent", () => {
    const n = g.nodes.find((x) => x.id === "implement")!;
    expect(n).toMatchObject({ state: "running", current: true, retries: 3, agentId: "ag1", visited: true });
    expect(g.nodes.find((x) => x.id === "qa")).toMatchObject({ state: "done", current: false });
    expect(g.nodes.find((x) => x.id === "babysit")).toMatchObject({ state: "pending", visited: false });
  });
  it("marks the path taken, loops included, and leaves the others", () => {
    const taken = g.edges.filter((e) => e.taken).map((e) => `${e.from}>${e.to}`).sort();
    expect(taken).toEqual(["implement>qa", "qa>implement"]);
    expect(g.edges.find((e) => e.from === "qa" && e.to === "implement")!.back).toBe(true);
  });
  it("lights up done when the run is done, and the PM when it is asked", () => {
    const finished = buildGraph(details, { ...run, status: "done", stage: null, endedAt: 99, history: [ev(10, "enter", "babysit"), ev(40, "done", null)] } as unknown as RunView);
    expect(finished.nodes.find((n) => n.id === "done")!.state).toBe("done");
    expect(finished.edges.find((e) => e.from === "babysit" && e.to === "done")!.taken).toBe(true);
    const pm = buildGraph(details, { ...run, pmPending: { stage: "implement", reason: "exhausted" } } as unknown as RunView);
    expect(pm.nodes.find((n) => n.id === "pm")!.state).toBe("waiting");
    expect(pm.edges.find((e) => e.to === "pm")!.taken).toBe(true);
  });
});
