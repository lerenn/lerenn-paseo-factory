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
  /** Where the verdict label chip goes (top-left corner and size), clear of nodes and other labels. */
  label: { x: number; y: number; w: number; h: number };
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export const NODE_W = 156;
export const NODE_H = 58;
/** Narrowest gap between two columns; widened for the edge tracks and the labels that sit in it. */
const GAP_MIN = 90;
const GAP_Y = 44;
/** Distance between two lanes (horizontal corridors above and below the nodes) and between two tracks in a gap. */
const LANE = 22;
const TRACK = 10;
const PAD = 14;
const MARGIN = 14;
export const LABEL_H = 14;
const LABEL_CHAR_W = 6.2;
const LABEL_PAD = 8;

/** Size of a verdict chip (10px text). */
export function labelWidth(text: string): number {
  return Math.ceil(text.length * LABEL_CHAR_W + LABEL_PAD);
}

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

  const colOf = new Map<string, number>();
  const layerKeys = [...new Set(ids.map((id) => layer.get(id) ?? 0))].sort((a, b) => a - b);
  for (const id of ids) colOf.set(id, layerKeys.indexOf(layer.get(id) ?? 0));
  const edgeList = rawEdges.map((e) => ({
    ...e,
    isBack: back.has(`${e.from}>${e.to}`) || e.from === e.to || (colOf.get(e.to) ?? 0) <= (colOf.get(e.from) ?? 0),
  }));
  const columns = orderColumns(ids, colOf, layerKeys.length, edgeList.filter((e) => !e.isBack));
  const rows = Math.max(1, ...columns.map((c) => c.length));

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
  // Routes: every edge uses one vertical track in the gap right of its source column and one in the gap left of its
  // target column (the same one when they are adjacent). Edges that skip columns, loops and self loops travel between
  // the two along a lane above (forward) or below (back) all the nodes, so no segment ever crosses a node.
  const routes = edgeList.map((e, index) => {
    const ca = colOf.get(e.from)!;
    const cb = colOf.get(e.to)!;
    const g1 = ca;
    const g2 = cb - 1;
    return { e, index, ca, cb, g1, g2, lane: g1 === g2 ? null : { dir: e.isBack ? ("bottom" as const) : ("top" as const), index: 0 }, label: labelWidth(e.verdict) };
  });
  const laneCount = { top: 0, bottom: 0 };
  for (const dir of ["top", "bottom"] as const) {
    // Interval colouring: edges whose gap ranges do not overlap share a lane.
    const used: [number, number][][] = [];
    for (const r of routes.filter((x) => x.lane?.dir === dir).sort((a, b) => Math.min(a.g1, a.g2) - Math.min(b.g1, b.g2) || a.index - b.index)) {
      const lo = Math.min(r.g1, r.g2);
      const hi = Math.max(r.g1, r.g2);
      let k = used.findIndex((ivs) => ivs.every(([l, h]) => hi < l || lo > h));
      if (k < 0) k = used.push([]) - 1;
      used[k].push([lo, hi]);
      r.lane!.index = k;
    }
    laneCount[dir] = used.length;
  }

  // Gaps (index -1 is the left margin): wide enough for the tracks and for the widest label leaving that column.
  const tracksIn = new Map<number, number[]>();
  for (const r of routes) for (const g of new Set([r.g1, r.g2])) tracksIn.set(g, [...(tracksIn.get(g) ?? []), r.index]);
  const gapWidth = (g: number): number => {
    const tracks = tracksIn.get(g)?.length ?? 0;
    const labels = Math.max(0, ...routes.filter((r) => r.ca === g).map((r) => r.label + 8));
    const need = tracks ? PAD * 2 + (tracks - 1) * TRACK : 0;
    return g < 0 ? Math.max(MARGIN, need) : Math.max(GAP_MIN, need, labels);
  };
  const colX: number[] = [];
  let cursor = gapWidth(-1);
  for (let c = 0; c < columns.length; c++) {
    colX.push(cursor);
    cursor += NODE_W + gapWidth(c);
  }
  const width = cursor - gapWidth(columns.length - 1) + MARGIN;
  const nodesTop = MARGIN + (laneCount.top ? LABEL_H + 2 + laneCount.top * LANE : 0);
  const totalH = rows * NODE_H + (rows - 1) * GAP_Y;

  const nodes: GraphNode[] = [];
  const pos = new Map<string, GraphNode>();
  columns.forEach((members, col) => {
    const colHeight = members.length * NODE_H + (members.length - 1) * GAP_Y;
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
        x: colX[col],
        y: nodesTop + (totalH - colHeight) / 2 + row * (NODE_H + GAP_Y),
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
  const nodesBottom = Math.max(...nodes.map((n) => n.y + n.h));
  const laneY = (dir: "top" | "bottom", k: number) => (dir === "top" ? nodesTop - LANE * (k + 1) : nodesBottom + LANE * (k + 1));

  // Ports: outgoing on the right side and incoming on the left side, spread and ordered by where the other end is.
  const portY = (id: string, side: "out" | "in"): Map<number, number> => {
    const n = pos.get(id)!;
    const mine = routes.filter((r) => (side === "out" ? r.e.from === id : r.e.to === id));
    const other = (r: (typeof routes)[number]) => pos.get(side === "out" ? r.e.to : r.e.from)!;
    mine.sort((a, b) => other(a).y + other(a).h / 2 - (other(b).y + other(b).h / 2) || a.index - b.index);
    return new Map(mine.map((r, i) => [r.index, n.y + (n.h * (i + 1)) / (mine.length + 1)]));
  };
  const outY = new Map<number, number>();
  const inY = new Map<number, number>();
  for (const n of nodes) {
    for (const [k, y] of portY(n.id, "out")) outY.set(k, y);
    for (const [k, y] of portY(n.id, "in")) inY.set(k, y);
  }

  // Tracks: in each gap, order the vertical tracks to minimise the crossings between them.
  interface Attach {
    route: number;
    left: number[];
    right: number[];
  }
  const attachments = new Map<number, Attach[]>();
  const attach = (g: number, a: Attach) => attachments.set(g, [...(attachments.get(g) ?? []), a]);
  for (const r of routes) {
    const sy = outY.get(r.index)!;
    const ty = inY.get(r.index)!;
    if (!r.lane) attach(r.g1, { route: r.index, left: [sy], right: [ty] });
    else {
      const ly = laneY(r.lane.dir, r.lane.index);
      if (r.e.isBack) {
        attach(r.g1, { route: r.index, left: [sy, ly], right: [] });
        attach(r.g2, { route: r.index, left: [], right: [ly, ty] });
      } else {
        attach(r.g1, { route: r.index, left: [sy], right: [ly] });
        attach(r.g2, { route: r.index, left: [ly], right: [ty] });
      }
    }
  }
  const span = (a: Attach): [number, number] => [Math.min(...a.left, ...a.right), Math.max(...a.left, ...a.right)];
  const inside = (y: number, [lo, hi]: [number, number]) => y > lo && y < hi;
  /** Crossings if `a` is left of `b`: b's left horizontals pass a's track, a's right ones pass b's track. */
  const crossings = (a: Attach, b: Attach) => b.left.filter((y) => inside(y, span(a))).length + a.right.filter((y) => inside(y, span(b))).length;
  const trackX = new Map<string, number>();
  for (const [g, list] of attachments) {
    const order = bestOrder(list, crossings);
    const start = g < 0 ? 0 : colX[g] + NODE_W;
    const free = gapWidth(g) - (order.length - 1) * TRACK;
    order.forEach((a, i) => trackX.set(`${g}:${a.route}`, start + free / 2 + i * TRACK));
  }

  type Pt = { x: number; y: number };
  const routed = routes.map((r) => {
    const a = pos.get(r.e.from)!;
    const b = pos.get(r.e.to)!;
    const sy = outY.get(r.index)!;
    const ty = inY.get(r.index)!;
    const x1 = trackX.get(`${r.g1}:${r.index}`)!;
    const x2 = trackX.get(`${r.g2}:${r.index}`)!;
    const points: Pt[] = r.lane
      ? (() => {
          const ly = laneY(r.lane.dir, r.lane.index);
          return [{ x: a.x + a.w, y: sy }, { x: x1, y: sy }, { x: x1, y: ly }, { x: x2, y: ly }, { x: x2, y: ty }, { x: b.x, y: ty }];
        })()
      : [{ x: a.x + a.w, y: sy }, { x: x1, y: sy }, { x: x1, y: ty }, { x: b.x, y: ty }];
    return { r, points };
  });

  const height = Math.max(nodesBottom + (laneCount.bottom ? laneCount.bottom * LANE + LABEL_H + 2 : 0), nodesBottom) + MARGIN;
  const labels = placeLabels(
    routed.map(({ r, points }) => ({ w: r.label, points })),
    nodes,
    width,
    height,
  );
  const edges: GraphEdge[] = routed.map(({ r, points }, i) => ({
    from: r.e.from,
    to: r.e.to,
    verdict: r.e.verdict,
    taken: taken.has(`${r.e.from}>${r.e.to}`),
    back: r.e.isBack,
    points,
    label: labels[i],
  }));

  return { nodes, edges, width, height };
}

type Rect = { x: number; y: number; w: number; h: number };
const overlaps = (a: Rect, b: Rect, slack = 0) => a.x < b.x + b.w + slack && b.x < a.x + a.w + slack && a.y < b.y + b.h + slack && b.y < a.y + a.h + slack;
const segRect = (p: { x: number; y: number }, q: { x: number; y: number }): Rect => ({ x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(p.x - q.x), h: Math.abs(p.y - q.y) });

/** Does an axis-aligned segment pass through the inside of a rectangle? (Touching the border does not count.) */
export function segmentCrossesRect(p: { x: number; y: number }, q: { x: number; y: number }, r: Rect): boolean {
  const s = segRect(p, q);
  return s.x < r.x + r.w && r.x < s.x + s.w && s.y < r.y + r.h && r.y < s.y + s.h && !(s.w === 0 && (s.x <= r.x || s.x >= r.x + r.w)) && !(s.h === 0 && (s.y <= r.y || s.y >= r.y + r.h));
}

/**
 * Chips for the verdicts, each next to its own edge: candidates along every segment (above/below horizontal ones, beside
 * vertical ones); never over a node or another chip, and as little as possible over other edges.
 */
function placeLabels(items: { w: number; points: { x: number; y: number }[] }[], nodes: GraphNode[], width: number, height: number): Rect[] {
  const placed: Rect[] = [];
  const result: Rect[] = items.map(() => ({ x: 0, y: 0, w: 0, h: LABEL_H }));
  // Fewest candidates first would be ideal; short edges are the tightest, so place by edge length.
  const lengthOf = (pts: { x: number; y: number }[]) => pts.slice(1).reduce((s, p, i) => s + Math.abs(p.x - pts[i].x) + Math.abs(p.y - pts[i].y), 0);
  const order = items.map((_, i) => i).sort((a, b) => lengthOf(items[a].points) - lengthOf(items[b].points) || a - b);
  const bounds: Rect = { x: 0, y: 0, w: width, h: height };
  for (const i of order) {
    const { w, points } = items[i];
    const candidates: Rect[] = [];
    const segs = points.slice(1).map((p, j) => [points[j], p] as const);
    // First the segment leaving the source, then the one entering the target, then the middle ones.
    const sequence = [0, segs.length - 1, ...segs.map((_, j) => j).slice(1, -1)];
    for (const j of sequence) {
      const [p, q] = segs[j];
      const lo = Math.min(p.x, q.x);
      const hi = Math.max(p.x, q.x);
      if (p.y === q.y) {
        const xs = [lo + 2, (lo + hi - w) / 2, hi - w - 2];
        // Entering segments read best with the chip at their start (next to the node it leaves), so keep order.
        for (const x of xs) for (const y of [p.y - LABEL_H - 1, p.y + 1]) candidates.push({ x, y, w, h: LABEL_H });
      } else {
        const my = (Math.min(p.y, q.y) + Math.max(p.y, q.y)) / 2;
        for (const x of [p.x + 4, p.x - 4 - w]) for (const y of [my - LABEL_H / 2, Math.min(p.y, q.y) + 2, Math.max(p.y, q.y) - LABEL_H - 2]) candidates.push({ x, y, w, h: LABEL_H });
      }
    }
    let best: Rect | null = null;
    let bestCost = Infinity;
    candidates.forEach((c, k) => {
      if (c.x < bounds.x || c.y < bounds.y || c.x + c.w > bounds.x + bounds.w || c.y + c.h > bounds.y + bounds.h) return;
      if (nodes.some((n) => overlaps(c, n, 2)) || placed.some((o) => overlaps(c, o, 2))) return;
      let cost = k * 0.1;
      items.forEach((it, m) => {
        for (let t = 1; t < it.points.length; t++) if (segmentCrossesRect(it.points[t - 1], it.points[t], c)) cost += m === i ? 5 : 3;
      });
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
      }
    });
    // No clean spot: fall back to the first candidate that at least clears the nodes, then to the first one.
    const chosen: Rect = best ?? candidates.find((c) => !nodes.some((n) => overlaps(c, n))) ?? candidates[0];
    placed.push(chosen);
    result[i] = chosen;
  }
  return result;
}

/** Order the tracks of a gap by trying every permutation when small, else by mean attachment height. */
function bestOrder<T extends { left: number[]; right: number[] }>(list: T[], cost: (a: T, b: T) => number): T[] {
  const mean = (a: T) => [...a.left, ...a.right].reduce((s, y) => s + y, 0) / Math.max(1, a.left.length + a.right.length);
  const sorted = [...list].sort((a, b) => mean(a) - mean(b));
  if (sorted.length > 7) return sorted;
  let best = sorted;
  let bestCost = Infinity;
  const permute = (rest: T[], acc: T[]) => {
    if (!rest.length) {
      let c = 0;
      for (let i = 0; i < acc.length; i++) for (let j = i + 1; j < acc.length; j++) c += cost(acc[i], acc[j]);
      if (c < bestCost) {
        bestCost = c;
        best = acc;
      }
      return;
    }
    rest.forEach((x, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x]));
  };
  permute(sorted, []);
  return best;
}

/** Stages of each column, ordered by barycenter sweeps so edges between neighbouring columns cross as little as possible. */
function orderColumns(ids: string[], colOf: Map<string, number>, count: number, forward: { from: string; to: string }[]): string[][] {
  const columns: string[][] = Array.from({ length: count }, () => []);
  for (const id of ids) columns[colOf.get(id)!].push(id);
  const fraction = new Map<string, number>();
  const refresh = () => columns.forEach((c) => c.forEach((id, i) => fraction.set(id, (i + 0.5) / c.length)));
  refresh();
  const neighbours = (id: string, side: "before" | "after") => {
    const col = colOf.get(id)!;
    return forward.flatMap((e) => (e.to === id && colOf.get(e.from)! < col && side === "before" ? [e.from] : e.from === id && colOf.get(e.to)! > col && side === "after" ? [e.to] : []));
  };
  const sweep = (cols: number[], side: "before" | "after") => {
    for (const c of cols) {
      const keyed = columns[c].map((id, i) => {
        const ns = neighbours(id, side);
        return { id, i, key: ns.length ? ns.reduce((s, n) => s + fraction.get(n)!, 0) / ns.length : fraction.get(id)! };
      });
      keyed.sort((a, b) => a.key - b.key || a.i - b.i);
      columns[c] = keyed.map((k) => k.id);
      refresh();
    }
  };
  const all = columns.map((_, i) => i);
  for (let round = 0; round < 4; round++) {
    sweep(all.slice(1), "before");
    sweep([...all].reverse().slice(1), "after");
  }
  return columns;
}
