import type { RunView } from "./run";
import type { StageDetail } from "./rpc";
import { buildTimeline } from "./timeline";

export type NodeState = "static" | "pending" | "waiting" | "running" | "done" | "blocked" | "failed" | "skipped";

export interface GraphNode {
  id: string;
  label: string;
  /** agent | gate | call | blueprint | terminal | pm */
  kind: string;
  role: string | null;
  childBlueprint: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
  state: NodeState;
  /** The stage the run is in now. */
  current: boolean;
  /** Entered at least once (run path), always true without a run. */
  visited: boolean;
  /** Extra tries: dispatches beyond the first, plus re-entries. */
  retries: number;
  agentId: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  verdict: string;
  /** The run really went this way. */
  taken: boolean;
  /** Goes back to an earlier (or the same) layer: a loop. */
  back: boolean;
  /** Axis-aligned polyline, in graph coordinates. */
  points: { x: number; y: number }[];
  /** Where the verdict label goes. */
  label: { x: number; y: number };
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export const NODE_W = 156;
export const NODE_H = 58;
const GAP_X = 70;
const GAP_Y = 26;
const LANE = 12;
const MARGIN = 14;

const TERMINAL = new Set(["done", "failed"]);

/** Layers by longest path from the first stage, ignoring edges that close a loop (found by depth-first search). */
export function layerStages(ids: string[], edges: [string, string][]): { layer: Map<string, number>; back: Set<string> } {
  const out = new Map<string, string[]>();
  for (const [a, b] of edges) out.set(a, [...(out.get(a) ?? []), b]);
  const back = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const next of out.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) back.add(`${id}>${next}`);
      else if (s === 0) visit(next);
    }
    state.set(id, 2);
  };
  if (ids[0]) visit(ids[0]);
  for (const id of ids) if (!state.has(id)) visit(id);
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  // Relax in topological-ish passes; bounded by the number of nodes since the forward graph is acyclic.
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const [a, b] of edges) {
      if (back.has(`${a}>${b}`) || a === b) continue;
      const want = (layer.get(a) ?? 0) + 1;
      if ((layer.get(b) ?? 0) < want) {
        layer.set(b, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { layer, back };
}

function stateOf(status: string | undefined): NodeState {
  switch (status) {
    case "waiting":
      return "waiting";
    case "running":
    case "entering":
      return "running";
    case "done":
      return "done";
    case "exhausted":
      return "blocked";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

/**
 * The shape of a blueprint (nodes are stages, edges are the verdict transitions of each stage's `on` table), optionally
 * overlaid with a run: state and retries per stage, the current stage, and the path actually taken.
 */
export function buildGraph(details: readonly StageDetail[], run?: RunView | null): Graph {
  const stages = details.map((d) => d.id);
  const known = new Set(stages);
  const rawEdges: { from: string; to: string; verdict: string }[] = [];
  for (const d of details) for (const [verdict, to] of Object.entries(d.on)) rawEdges.push({ from: d.id, to, verdict });

  // Terminal and PM pseudo-nodes, only when something points at them.
  const extra: string[] = [];
  for (const e of rawEdges) if (!known.has(e.to) && !extra.includes(e.to)) extra.push(e.to);
  const ids = [...stages, ...extra];
  const { layer, back } = layerStages(ids, rawEdges.map((e) => [e.from, e.to]));
  // Terminals sit in the last column.
  const maxLayer = Math.max(0, ...stages.map((id) => layer.get(id) ?? 0));
  for (const id of extra) layer.set(id, TERMINAL.has(id) ? maxLayer + 1 : Math.max(layer.get(id) ?? 0, 1));

  const byLayer = new Map<number, string[]>();
  for (const id of ids) byLayer.set(layer.get(id) ?? 0, [...(byLayer.get(layer.get(id) ?? 0) ?? []), id]);
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const rows = Math.max(1, ...[...byLayer.values()].map((v) => v.length));

  const taken = new Set<string>();
  const entered = new Map<string, number>();
  if (run) {
    const segs = buildTimeline(run.history, Date.now(), run.endedAt);
    for (let i = 0; i < segs.length; i++) {
      entered.set(segs[i].stage, (entered.get(segs[i].stage) ?? 0) + 1);
      const next = segs[i + 1]?.stage ?? (run.status === "done" && i === segs.length - 1 ? "done" : run.status === "failed" && i === segs.length - 1 ? "failed" : null);
      if (next) taken.add(`${segs[i].stage}>${next}`);
    }
    if (run.pmPending) taken.add(`${run.pmPending.stage}>pm`);
  }

  const detail = new Map(details.map((d) => [d.id, d]));
  const view = new Map((run?.stages ?? []).map((s) => [s.id, s]));
  const nodes: GraphNode[] = [];
  const pos = new Map<string, GraphNode>();
  layers.forEach((l, col) => {
    const members = byLayer.get(l)!;
    const colHeight = members.length * NODE_H + (members.length - 1) * GAP_Y;
    const total = rows * NODE_H + (rows - 1) * GAP_Y;
    members.forEach((id, row) => {
      const d = detail.get(id);
      const sv = view.get(id);
      const terminal = TERMINAL.has(id);
      const isPm = id === "pm" && !known.has(id);
      const reached = terminal ? run?.status === id : isPm ? !!run?.pmPending || [...taken].some((t) => t.endsWith(">pm")) : (entered.get(id) ?? 0) > 0;
      const node: GraphNode = {
        id,
        label: d?.title || id,
        kind: terminal ? "terminal" : isPm ? "pm" : d?.kind ?? "agent",
        role: d?.role ?? null,
        childBlueprint: d?.childBlueprint ?? null,
        x: MARGIN + col * (NODE_W + GAP_X),
        y: MARGIN + LANE * 3 + (total - colHeight) / 2 + row * (NODE_H + GAP_Y),
        w: NODE_W,
        h: terminal || isPm ? 40 : NODE_H,
        layer: col,
        state: !run ? "static" : terminal ? (reached ? (id === "done" ? "done" : "failed") : "pending") : isPm ? (reached ? "waiting" : "pending") : stateOf(sv?.status),
        current: !!run && run.stage === id && run.endedAt === null,
        visited: !run || reached,
        retries: sv ? Math.max(0, sv.attempts - 1) + Math.max(0, sv.runs - 1) : 0,
        agentId: sv?.agentId ?? null,
      };
      if (node.h < NODE_H) node.y += (NODE_H - node.h) / 2;
      nodes.push(node);
      pos.set(id, node);
    });
  });

  // Edges: elbow connectors. Exits are spread along the node side so they never overlap.
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const e of rawEdges) {
    outgoing.set(e.from, (outgoing.get(e.from) ?? 0) + 1);
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  }
  const outIndex = new Map<string, number>();
  const inIndex = new Map<string, number>();
  let lowerLane = 0;
  let upperLane = 0;
  const bottomOfNodes = Math.max(...nodes.map((n) => n.y + n.h));
  const edges: GraphEdge[] = rawEdges.map((e) => {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    const oi = outIndex.get(e.from) ?? 0;
    outIndex.set(e.from, oi + 1);
    const ii = inIndex.get(e.to) ?? 0;
    inIndex.set(e.to, ii + 1);
    const isBack = back.has(`${e.from}>${e.to}`) || e.from === e.to;
    const span = b.layer - a.layer;
    const sy = a.y + (a.h * (oi + 1)) / ((outgoing.get(e.from) ?? 1) + 1);
    const ty = b.y + (b.h * (ii + 1)) / ((incoming.get(e.to) ?? 1) + 1);
    let points: { x: number; y: number }[];
    if (isBack) {
      // Down from the source's bottom, along a private lane under the nodes, up into the target's bottom.
      const lane = bottomOfNodes + LANE * (++lowerLane + 1);
      const sx = a.x + (a.w * (oi + 1)) / ((outgoing.get(e.from) ?? 1) + 1);
      const tx = b.x + (b.w * (ii + 1)) / ((incoming.get(e.to) ?? 1) + 1);
      points = [{ x: sx, y: a.y + a.h }, { x: sx, y: lane }, { x: tx, y: lane }, { x: tx, y: b.y + b.h }];
    } else if (span > 1) {
      // Skips a column: run above the nodes so it does not cross the ones in between.
      const lane = MARGIN + LANE * (3 - Math.min(2, upperLane++));
      points = [{ x: a.x + a.w, y: sy }, { x: a.x + a.w + 10 + oi * 4, y: sy }, { x: a.x + a.w + 10 + oi * 4, y: lane }, { x: b.x - 10 - ii * 4, y: lane }, { x: b.x - 10 - ii * 4, y: ty }, { x: b.x, y: ty }];
    } else {
      const mx = a.x + a.w + GAP_X / 2 + ((oi % 3) - 1) * 6;
      points = [{ x: a.x + a.w, y: sy }, { x: mx, y: sy }, { x: mx, y: ty }, { x: b.x, y: ty }];
    }
    return {
      from: e.from,
      to: e.to,
      verdict: e.verdict,
      taken: taken.has(`${e.from}>${e.to}`),
      back: isBack,
      points,
      label: isBack ? { x: points[1].x + 4, y: points[1].y - 12 } : { x: points[0].x + 4, y: points[0].y - 13 },
    };
  });

  const width = MARGIN * 2 + layers.length * NODE_W + Math.max(0, layers.length - 1) * GAP_X;
  const height = bottomOfNodes + LANE * (lowerLane + 2) + MARGIN;
  return { nodes, edges, width, height };
}
