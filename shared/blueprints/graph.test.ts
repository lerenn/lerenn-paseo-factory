import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildGraph, layerStages, LABEL_H, labelWidth, NODE_H, NODE_W, segmentCrossesRect, SUB_CHAR_W, SUB_LINE_H, TEXT_PAD, TITLE_LINE_H, titleCapacity, type Graph } from "./graph";
import { parseBlueprint } from "../../server/blueprints/toml";
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
  it("has a node per stage plus done; failures are stubs, not nodes", () => {
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["ask", "babysit", "done", "implement", "qa"]);
    expect(g.nodes.every((n) => n.state === "static" && n.visited)).toBe(true);
    expect(g.nodes.find((n) => n.id === "babysit")!.childBlueprint).toBe("babysit-pr");
  });
  it("has an edge per verdict, loops marked back and routed under the nodes", () => {
    expect(g.edges).toHaveLength(8);
    const loops = g.edges.filter((e) => e.back).map((e) => `${e.from}>${e.to}`).sort();
    expect(loops).toEqual(["ask>implement", "babysit>implement", "qa>implement"]);
    expect(g.edges.filter((e) => e.stub).map((e) => `${e.from}>${e.to}`)).toEqual(["implement>pm"]);
    // Loops stay next to the nodes they join: leave the left side of the source, enter the right side of the target.
    const at = (id: string) => g.nodes.find((n) => n.id === id)!;
    for (const e of g.edges.filter((x) => x.back)) {
      expect(e.points[0].x).toBe(at(e.from).x);
      expect(e.points[e.points.length - 1].x).toBe(at(e.to).x + at(e.to).w);
    }
  });
  it("never overlaps two nodes and keeps edges axis-aligned", () => {
    for (const a of g.nodes) for (const b of g.nodes) if (a.id < b.id) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    for (const e of g.edges) e.points.slice(1).forEach((p, i) => expect(p.x === e.points[i].x || p.y === e.points[i].y).toBe(true));
    expect(g.nodes.find((n) => n.id === "implement")!.w).toBe(NODE_W);
    expect(g.nodes.find((n) => n.id === "implement")!.h).toBeGreaterThanOrEqual(NODE_H);
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
    expect(pm.edges.find((e) => e.to === "pm")!.taken).toBe(true);
  });
});

describe("readable layout of the shipped blueprints", () => {
  const load = (name: string): StageDetail[] =>
    parseBlueprint(readFileSync(new URL(`../examples/blueprints/${name}.toml`, import.meta.url), "utf8")).blueprint.stage.map((st) => {
      const kind = st.kind ?? "agent";
      return { ...base, id: st.id, kind, role: (st as { role?: string }).role ?? null, on: st.on, childBlueprint: kind === "blueprint" ? (st as { blueprint: string }).blueprint : null };
    });
  const boxes = (g: Graph) => g.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }));
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  for (const name of ["incident", "ticket"]) {
    describe(name, () => {
      const g = buildGraph(load(name));
      it("has no node overlap and stays axis-aligned", () => {
        const b = boxes(g);
        for (const x of b) for (const y of b) if (x.id < y.id) expect(overlap(x, y), `${x.id} / ${y.id}`).toBe(false);
        for (const e of g.edges) e.points.slice(1).forEach((p, i) => expect(p.x === e.points[i].x || p.y === e.points[i].y).toBe(true));
      });
      it("never routes an edge segment through a node", () => {
        for (const e of g.edges)
          for (let i = 1; i < e.points.length; i++) for (const n of boxes(g)) expect(segmentCrossesRect(e.points[i - 1], e.points[i], n), `${e.from}>${e.to} (${e.verdict}) through ${n.id}`).toBe(false);
      });
      it("keeps every label clear of nodes, other labels and the canvas border", () => {
        const labels = g.edges.map((e) => ({ id: `${e.from}>${e.to}:${e.verdict}`, ...e.label }));
        for (const e of g.edges) {
          expect(e.label.w).toBe(labelWidth(e.labelText));
          expect(e.label.h).toBe(LABEL_H);
        }
        for (const l of labels) {
          expect(l.x >= 0 && l.y >= 0 && l.x + l.w <= g.width && l.y + l.h <= g.height, `${l.id} inside canvas`).toBe(true);
          for (const n of boxes(g)) expect(overlap(l, n), `${l.id} over node ${n.id}`).toBe(false);
        }
        for (const a of labels) for (const b of labels) if (a.id < b.id) expect(overlap(a, b), `${a.id} / ${b.id}`).toBe(false);
      });
      it("keeps each label next to its own edge", () => {
        for (const e of g.edges) {
          const l = e.label;
          const near = e.points.slice(1).some((p, i) => segmentCrossesRect(e.points[i], p, { x: l.x - 3, y: l.y - 3, w: l.w + 6, h: l.h + 6 }));
          expect(near, `${e.from}>${e.to} ${e.verdict}`).toBe(true);
        }
      });
      it("keeps the content inside the canvas, labels and edges included", () => {
        for (const n of g.nodes) expect(n.x >= 0 && n.y >= 0 && n.x + n.w <= g.width && n.y + n.h <= g.height, n.id).toBe(true);
        for (const e of g.edges) {
          for (const p of e.points) expect(p.x >= 0 && p.y >= 0 && p.x <= g.width && p.y <= g.height, `${e.from}>${e.to} point`).toBe(true);
          expect(e.label.x + e.label.w <= g.width && e.label.y + e.label.h <= g.height, `${e.from}>${e.to} label`).toBe(true);
        }
      });
      it("never runs an edge along a node border and enters from the right side", () => {
        const near = (v: number, w: number) => Math.abs(v - w) < 4;
        for (const e of g.edges)
          for (let i = 1; i < e.points.length; i++)
            for (const n of g.nodes) {
              const p = e.points[i - 1];
              const q = e.points[i];
              const vertical = p.x === q.x;
              const along = vertical ? (near(p.x, n.x) || near(p.x, n.x + n.w)) && Math.min(p.y, q.y) < n.y + n.h && Math.max(p.y, q.y) > n.y : (near(p.y, n.y) || near(p.y, n.y + n.h)) && Math.min(p.x, q.x) < n.x + n.w && Math.max(p.x, q.x) > n.x;
              // The segment that starts or ends at its own port is the one allowed to touch.
              const own = (e.from === n.id && i === 1) || (e.to === n.id && i === e.points.length - 1);
              if (!own && !e.stub) expect(along, `${e.from}>${e.to} (${e.verdict}) along ${n.id}`).toBe(false);
            }
        for (const e of g.edges.filter((x) => !x.stub)) {
          const last = e.points[e.points.length - 1];
          const target = g.nodes.find((n) => n.id === e.to)!;
          expect(last.x, `${e.from}>${e.to} enters ${e.back ? "right" : "left"}`).toBe(e.back ? target.x + target.w : target.x);
        }
      });
      it("keeps parallel lanes of different edges at least 8px apart", () => {
        const segs = g.edges.flatMap((e, k) => e.points.slice(1).map((p, i) => ({ k, p: e.points[i], q: p, stub: e.stub, from: e.from })));
        for (const a of segs)
          for (const b of segs) {
            if (a.k >= b.k) continue;
            if (a.stub && b.stub && a.from === b.from) continue;
            const av = a.p.x === a.q.x;
            const bv = b.p.x === b.q.x;
            if (av !== bv || (a.p.x === a.q.x && a.p.y === a.q.y) || (b.p.x === b.q.x && b.p.y === b.q.y)) continue;
            const [ad, bd] = av ? [a.p.x, b.p.x] : [a.p.y, b.p.y];
            const [a0, a1, b0, b1] = av ? [Math.min(a.p.y, a.q.y), Math.max(a.p.y, a.q.y), Math.min(b.p.y, b.q.y), Math.max(b.p.y, b.q.y)] : [Math.min(a.p.x, a.q.x), Math.max(a.p.x, a.q.x), Math.min(b.p.x, b.q.x), Math.max(b.p.x, b.q.x)];
            // Port runs that only share the width of a track pair are crossings, not parallel lanes.
            if (Math.min(a1, b1) - Math.max(a0, b0) <= 12) continue;
            expect(Math.abs(ad - bd), `${g.edges[a.k].verdict} / ${g.edges[b.k].verdict}`).toBeGreaterThanOrEqual(8);
          }
      });
      it("fits the text of every node in its box", () => {
        for (const n of g.nodes) {
          expect(n.title.length, `${n.id} title`).toBeLessThanOrEqual(titleCapacity(n.kind) * n.titleLines);
          expect(n.titleLines).toBeLessThanOrEqual(2);
          expect(n.subtitle.length * SUB_CHAR_W, `${n.id} subtitle`).toBeLessThanOrEqual(n.w - 2 * TEXT_PAD);
          const need = n.kind === "terminal" ? TITLE_LINE_H : n.titleLines * TITLE_LINE_H + (n.subtitle ? SUB_LINE_H : 0);
          expect(need + 2 * 6, `${n.id} height`).toBeLessThanOrEqual(n.h);
        }
      });
      it("gives every edge its own track and port", () => {
        const seen = new Set<string>();
        for (const e of g.edges) {
          if (e.stub) continue;
          const first = `out:${e.from}:${e.points[0].x}:${e.points[0].y}`;
          const last = `in:${e.to}:${e.points[e.points.length - 1].x}:${e.points[e.points.length - 1].y}`;
          expect(seen.has(first) || seen.has(last), `${e.from}>${e.to}`).toBe(false);
          seen.add(first);
          seen.add(last);
        }
      });
    });
  }
});
