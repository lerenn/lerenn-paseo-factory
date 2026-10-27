import type { RunView } from "./run";
import type { StageDetail } from "./rpc";
import { buildTimeline } from "./timeline";

export type NodeState = "static" | "pending" | "waiting" | "running" | "done" | "blocked" | "failed" | "skipped";

export interface GraphNode {
  id: string;
  label: string;
  /** What the box shows as its title (the label, with a "? " for gates), over `titleLines` lines. */
  title: string;
  titleLines: number;
  /** Second line: the role, the child blueprint, "Inbox question"... Empty for terminals. */
  subtitle: string;
  /** agent | gate | call | blueprint | terminal */
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
  /** Goes back to an earlier (or the same) column: a loop. It leaves the left side of its source and enters the right side of its target. */
  back: boolean;
  /** A failure edge (to the PM or to failed): a short stub under its source ending in its label, not a line across the graph. */
  stub: boolean;
  /** Axis-aligned polyline, in graph coordinates. */
  points: { x: number; y: number }[];
  /** What the chip says: the verdict, plus "→ target" for stubs. */
  labelText: string;
  /** The label chip (top-left corner and size); it touches its own edge and avoids nodes and other chips. */
  label: { x: number; y: number; w: number; h: number };
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The canvas: it contains every node, edge and label. */
  width: number;
  height: number;
}

export const NODE_W = 156;
export const NODE_H = 58;
export const TERMINAL_H = 40;
/** Narrowest gap between two columns; widened for the edge tracks and the labels that sit in it. */
const GAP_MIN = 90;
/** Narrowest gap between two rows. */
const GAP_Y = 30;
/** Distance between two lanes (horizontal corridors between the rows) and between two tracks in a gap. */
export const LANE = 22;
export const TRACK = 10;
/** Distance between two ports on a side of a node. */
export const PORT = 12;
const PAD = 14;
const MARGIN = 14;
export const LABEL_H = 14;
const LABEL_CHAR_W = 6.2;
const LABEL_PAD = 8;
/** Failure stubs under a node: one 18px row each. */
const STUB_ROW = 18;
const STUB_LEN = 10;
/** Text metrics of the node boxes (12px bold title, 10px subtitle and state line). */
export const TEXT_PAD = 8;
export const TITLE_CHAR_W = 7.2;
export const SUB_CHAR_W = 5.9;
export const TITLE_LINE_H = 15;
export const SUB_LINE_H = 13;
export const STATE_LINE_H = 14;
const BOX_PAD_Y = 6;

/** Size of a verdict chip (10px text). */
export function labelWidth(text: string): number {
  return Math.ceil(text.length * LABEL_CHAR_W + LABEL_PAD);
}

/** How many characters of a title fit on a line of a node box. */
export function titleCapacity(kind: string): number {
  return Math.floor((NODE_W - 2 * TEXT_PAD - (kind === "blueprint" ? 14 : 0)) / TITLE_CHAR_W);
}

export function subtitleOf(kind: string, role: string | null, childBlueprint: string | null): string {
  return kind === "terminal" ? "" : kind === "gate" ? "Inbox question" : kind === "blueprint" ? `run ${childBlueprint ?? "blueprint"}` : kind === "call" ? "tool call" : (role ?? "");
}

/** Height a box needs for its text: title lines (at most two), subtitle and, with a run, the state line. */
export function nodeHeight(kind: string, titleLines: number, subtitle: string, withState: boolean): number {
  if (kind === "terminal") return Math.max(TERMINAL_H, 2 * BOX_PAD_Y + TITLE_LINE_H);
  return Math.max(NODE_H, 2 * BOX_PAD_Y + titleLines * TITLE_LINE_H + (subtitle ? SUB_LINE_H : 0) + (withState ? STATE_LINE_H : 0));
}

const TERMINAL = new Set(["done"]);
/** Targets that are not stages and are drawn as a stub on their sources, not as nodes. */
const SINKS = new Set(["pm", "failed"]);

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
 *
 * Layout: columns by longest path, rows top-aligned. Between the rows run horizontal channels with lanes; between the
 * columns, gaps with one vertical track per edge. A forward edge leaves the right side of its source and enters the left
 * side of its target; a loop leaves the left side of its source and enters the right side of its target, so it stays
 * in the gaps next to the nodes it joins. Edges that skip columns (or loop further than one) travel along the channel
 * nearest to their ends. Failure edges (to the PM, to failed) are short stubs under their source ending in their label.
 */
export function buildGraph(details: readonly StageDetail[], run?: RunView | null): Graph {
  const stages = details.map((d) => d.id);
  const known = new Set(stages);
  const rawEdges: { from: string; to: string; verdict: string }[] = [];
  for (const d of details) for (const [verdict, to] of Object.entries(d.on)) rawEdges.push({ from: d.id, to, verdict });
  const isSink = (id: string) => !known.has(id) && SINKS.has(id);

  // Terminal pseudo-nodes, only when something points at them.
  const extra: string[] = [];
  for (const e of rawEdges) if (!known.has(e.to) && !isSink(e.to) && !extra.includes(e.to)) extra.push(e.to);
  const ids = [...stages, ...extra];
  const { layer, back } = layerStages(ids, rawEdges.filter((e) => !isSink(e.to)).map((e) => [e.from, e.to]));
  // Terminals sit in the last column.
  const maxLayer = Math.max(0, ...stages.map((id) => layer.get(id) ?? 0));
  for (const id of extra) layer.set(id, TERMINAL.has(id) ? maxLayer + 1 : Math.max(layer.get(id) ?? 0, 1));

  const colOf = new Map<string, number>();
  const layerKeys = [...new Set(ids.map((id) => layer.get(id) ?? 0))].sort((a, b) => a - b);
  for (const id of ids) colOf.set(id, layerKeys.indexOf(layer.get(id) ?? 0));
  const edgeList = rawEdges.map((e) => {
    const stub = isSink(e.to);
    return { ...e, stub, isBack: !stub && (back.has(`${e.from}>${e.to}`) || e.from === e.to || (colOf.get(e.to) ?? 0) <= (colOf.get(e.from) ?? 0)) };
  });
  const columns = orderColumns(ids, colOf, layerKeys.length, edgeList.filter((e) => !e.isBack && !e.stub));
  const cols = columns.length;
  const rows = Math.max(1, ...columns.map((c) => c.length));
  const rowOf = new Map<string, number>();
  columns.forEach((c) => c.forEach((id, r) => rowOf.set(id, r)));

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

  // Routes. Forward: leaves the right of the source into the gap after its column (g1), enters the left of the target
  // from the gap before its column (g2). Loop: leaves the left of the source into the gap before its column, enters the
  // right of the target from the gap after its column. One gap on both ends means a plain Z; otherwise a lane.
  const routes = edgeList.map((e, index) => {
    const ca = colOf.get(e.from)!;
    const cb = e.stub ? ca : colOf.get(e.to)!;
    const g1 = e.isBack ? ca - 1 : ca;
    const g2 = e.isBack ? cb : cb - 1;
    const text = e.stub ? `${e.verdict} → ${e.to}` : e.verdict;
    return { e, index, ca, cb, g1, g2, lane: null as null | { channel: number; index: number }, text, label: labelWidth(text) };
  });
  const needsLane = (r: (typeof routes)[number]) => !r.e.stub && r.g1 !== r.g2;

  // Channel c runs above row c (c = rows is below the last row). Pick the one that costs the fewest rows of vertical
  // travel and the least crowding; lanes of a channel are shared by edges whose gap ranges do not overlap.
  const distToRow = (c: number, r: number) => (c <= r ? r - c : c - r - 1);
  const inChannel: (typeof routes)[number][][] = Array.from({ length: rows + 1 }, () => []);
  const span = (r: (typeof routes)[number]): [number, number] => [Math.min(r.g1, r.g2), Math.max(r.g1, r.g2)];
  const clash = (a: (typeof routes)[number], b: (typeof routes)[number]) => !(span(a)[1] < span(b)[0] || span(a)[0] > span(b)[1]);
  for (const r of routes.filter(needsLane).sort((a, b) => span(a)[1] - span(a)[0] - (span(b)[1] - span(b)[0]) || a.index - b.index)) {
    const rs = rowOf.get(r.e.from)!;
    const rt = rowOf.get(r.e.to)!;
    let best = 0;
    let bestCost = Infinity;
    for (let c = 0; c <= rows; c++) {
      const crowd = inChannel[c].filter((o) => clash(o, r)).length;
      // Loops prefer to go under, forward edges over, when nothing else decides.
      const cost = distToRow(c, rs) + distToRow(c, rt) + crowd * 0.6 + (r.e.isBack ? (rows - c) * 0.01 : c * 0.01);
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
      }
    }
    inChannel[best].push(r);
    r.lane = { channel: best, index: 0 };
  }
  const laneCount: number[] = inChannel.map((list) => {
    const used: [number, number][][] = [];
    for (const r of [...list].sort((a, b) => span(a)[0] - span(b)[0] || a.index - b.index)) {
      const [lo, hi] = span(r);
      let k = used.findIndex((ivs) => ivs.every(([l, h]) => hi < l || lo > h));
      if (k < 0) k = used.push([]) - 1;
      used[k].push([lo, hi]);
      r.lane!.index = k;
    }
    return used.length;
  });

  // Gaps (index -1 is the left margin, cols - 1 the right one): wide enough for the tracks and for the widest label leaving.
  const tracksIn = new Map<number, number>();
  for (const r of routes) if (!r.e.stub) for (const g of new Set([r.g1, r.g2])) tracksIn.set(g, (tracksIn.get(g) ?? 0) + 1);
  const gapWidth = (g: number): number => {
    const tracks = tracksIn.get(g) ?? 0;
    const labels = Math.max(0, ...routes.filter((r) => !r.e.stub && r.g1 === g).map((r) => r.label + 8));
    const need = tracks ? PAD * 2 + (tracks - 1) * TRACK : 0;
    return g < 0 || g === cols - 1 ? Math.max(MARGIN, need) : Math.max(GAP_MIN, need, labels);
  };
  const colX: number[] = [];
  let cursor = gapWidth(-1);
  for (let c = 0; c < cols; c++) {
    colX.push(cursor);
    cursor += NODE_W + gapWidth(c);
  }
  const gapsWidth = cursor;

  // Box sizes: the text, and a port every PORT px on each side.
  const stubsOf = new Map<string, typeof routes>();
  const portsOf = (id: string, side: "left" | "right") =>
    routes.filter((r) => !r.e.stub && ((r.e.from === id && (side === "right") !== r.e.isBack) || (r.e.to === id && (side === "left") !== r.e.isBack)));
  for (const r of routes.filter((x) => x.e.stub)) stubsOf.set(r.e.from, [...(stubsOf.get(r.e.from) ?? []), r]);
  for (const list of stubsOf.values()) list.sort((a, b) => a.e.verdict.localeCompare(b.e.verdict) || a.index - b.index);

  const nodes: GraphNode[] = [];
  const pos = new Map<string, GraphNode>();
  columns.forEach((members, col) => {
    members.forEach((id) => {
      const d = detail.get(id);
      const sv = view.get(id);
      const terminal = TERMINAL.has(id);
      const reached = terminal ? run?.status === id : (entered.get(id) ?? 0) > 0;
      const kind = terminal ? "terminal" : (d?.kind ?? "agent");
      const label = d?.title || id;
      const title = `${kind === "gate" ? "? " : ""}${label}`;
      const titleLines = Math.min(2, Math.max(1, Math.ceil(title.length / titleCapacity(kind))));
      const subtitle = subtitleOf(kind, d?.role ?? null, d?.childBlueprint ?? null);
      const ports = Math.max(portsOf(id, "left").length, portsOf(id, "right").length);
      const node: GraphNode = {
        id,
        label,
        title,
        titleLines,
        subtitle,
        kind,
        role: d?.role ?? null,
        childBlueprint: d?.childBlueprint ?? null,
        x: colX[col],
        y: 0,
        w: NODE_W,
        h: Math.max(nodeHeight(kind, titleLines, subtitle, !!run && !terminal), (ports + 1) * PORT),
        layer: col,
        state: !run ? "static" : terminal ? (reached ? "done" : "pending") : stateOf(sv?.status),
        current: !!run && run.stage === id && run.endedAt === null,
        visited: !run || reached,
        retries: sv ? Math.max(0, sv.attempts - 1) + Math.max(0, sv.runs - 1) : 0,
        agentId: sv?.agentId ?? null,
      };
      nodes.push(node);
      pos.set(id, node);
    });
  });

  // Vertical layout: channel 0, row 0, its stubs, channel 1, row 1, ... channel `rows`.
  const rowH = Array.from({ length: rows }, (_, r) => Math.max(0, ...nodes.filter((n) => rowOf.get(n.id) === r).map((n) => n.h)));
  const stubSpace = Array.from({ length: rows }, (_, r) => {
    const most = Math.max(0, ...nodes.filter((n) => rowOf.get(n.id) === r).map((n) => stubsOf.get(n.id)?.length ?? 0));
    return most ? most * STUB_ROW + 6 : 0;
  });
  const rowTop: number[] = [];
  const laneTop: number[] = [];
  const channelH: number[] = [];
  let y = MARGIN;
  for (let c = 0; c <= rows; c++) {
    const lanes = laneCount[c];
    channelH[c] = Math.max(lanes ? lanes * LANE + 12 : 0, c > 0 && c < rows ? GAP_Y : 0);
    laneTop[c] = y + (channelH[c] - lanes * LANE) / 2;
    y += channelH[c];
    if (c < rows) {
      rowTop[c] = y;
      y += rowH[c] + stubSpace[c];
    }
  }
  const layoutBottom = y + MARGIN;
  const laneY = (channel: number, k: number) => laneTop[channel] + LANE * (k + 0.5);
  for (const n of nodes) n.y = rowTop[rowOf.get(n.id)!] + (rowH[rowOf.get(n.id)!] - n.h) / 2;

  // Ports: on the right side forward exits and loop entries, on the left side forward entries and loop exits; ordered
  // by where the first turn of the edge is, spread evenly.
  const turnY = (r: (typeof routes)[number], other: string) => (r.lane ? laneY(r.lane.channel, r.lane.index) : pos.get(other)!.y + pos.get(other)!.h / 2);
  const outY = new Map<number, number>();
  const inY = new Map<number, number>();
  for (const n of nodes) {
    for (const side of ["left", "right"] as const) {
      const mine = portsOf(n.id, side);
      mine.sort((a, b) => {
        const ka = turnY(a, a.e.from === n.id ? a.e.to : a.e.from);
        const kb = turnY(b, b.e.from === n.id ? b.e.to : b.e.from);
        return ka - kb || a.index - b.index;
      });
      mine.forEach((r, i) => {
        const py = n.y + (n.h * (i + 1)) / (mine.length + 1);
        // A self loop both leaves and enters this node: it appears once on each side, so tell them apart by direction.
        if (r.e.from === n.id && (side === "right") !== r.e.isBack) outY.set(r.index, py);
        if (r.e.to === n.id && (side === "left") !== r.e.isBack) inY.set(r.index, py);
      });
    }
  }

  // Tracks: in each gap, order the vertical tracks to minimise the crossings between them.
  interface Attach {
    route: number;
    left: number[];
    right: number[];
  }
  const attachments = new Map<number, Attach[]>();
  const attach = (g: number, a: Attach) => attachments.set(g, [...(attachments.get(g) ?? []), a]);
  for (const r of routes.filter((x) => !x.e.stub)) {
    const sy = outY.get(r.index)!;
    const ty = inY.get(r.index)!;
    const srcSide = r.e.isBack ? "right" : "left";
    const dstSide = r.e.isBack ? "left" : "right";
    if (!r.lane) {
      const a: Attach = { route: r.index, left: [], right: [] };
      a[srcSide].push(sy);
      a[dstSide].push(ty);
      attach(r.g1, a);
    } else {
      const ly = laneY(r.lane.channel, r.lane.index);
      const toRight = r.g2 > r.g1;
      const a1: Attach = { route: r.index, left: [], right: [] };
      a1[srcSide].push(sy);
      a1[toRight ? "right" : "left"].push(ly);
      const a2: Attach = { route: r.index, left: [], right: [] };
      a2[dstSide].push(ty);
      a2[toRight ? "left" : "right"].push(ly);
      attach(r.g1, a1);
      attach(r.g2, a2);
    }
  }
  const extent = (a: Attach): [number, number] => [Math.min(...a.left, ...a.right), Math.max(...a.left, ...a.right)];
  const inside = (v: number, [lo, hi]: [number, number]) => v > lo && v < hi;
  /** Crossings if `a` is left of `b`: b's left horizontals pass a's track, a's right ones pass b's track. */
  const crossings = (a: Attach, b: Attach) =>
    b.left.filter((v) => inside(v, extent(a))).length +
    a.right.filter((v) => inside(v, extent(b))).length +
    // Two horizontals at the same height would run into each other between the tracks.
    50 * a.right.filter((v) => b.left.some((w) => Math.abs(v - w) < 1)).length;
  const trackX = new Map<string, number>();
  for (const [g, list] of attachments) {
    const order = bestOrder(list, crossings);
    const start = g < 0 ? 0 : colX[g] + NODE_W;
    const free = gapWidth(g) - (order.length - 1) * TRACK;
    order.forEach((a, i) => trackX.set(`${g}:${a.route}`, start + free / 2 + i * TRACK));
  }

  type Pt = { x: number; y: number };
  const fixed: (Rect | null)[] = routes.map(() => null);
  const routed = routes.map((r) => {
    const a = pos.get(r.e.from)!;
    if (r.e.stub) {
      const list = stubsOf.get(a.id)!;
      const k = list.indexOf(r);
      const tx = a.x + 10;
      const sy = a.y + a.h + 9 + k * STUB_ROW;
      fixed[r.index] = { x: tx + STUB_LEN, y: sy - LABEL_H / 2, w: r.label, h: LABEL_H };
      return { r, points: [{ x: tx, y: a.y + a.h }, { x: tx, y: sy }, { x: tx + STUB_LEN, y: sy }] as Pt[] };
    }
    const b = pos.get(r.e.to)!;
    const sy = outY.get(r.index)!;
    const ty = inY.get(r.index)!;
    const x1 = trackX.get(`${r.g1}:${r.index}`)!;
    const x2 = trackX.get(`${r.g2}:${r.index}`)!;
    const start: Pt = { x: r.e.isBack ? a.x : a.x + a.w, y: sy };
    const end: Pt = { x: r.e.isBack ? b.x + b.w : b.x, y: ty };
    if (!r.lane) return { r, points: [start, { x: x1, y: sy }, { x: x1, y: ty }, end] as Pt[] };
    const ly = laneY(r.lane.channel, r.lane.index);
    return { r, points: [start, { x: x1, y: sy }, { x: x1, y: ly }, { x: x2, y: ly }, { x: x2, y: ty }, end] as Pt[] };
  });

  const labels = placeLabels(
    routed.map(({ r, points }) => ({ w: r.label, points, fixed: fixed[r.index] })),
    nodes,
  );
  const edges: GraphEdge[] = routed.map(({ r, points }, i) => ({
    from: r.e.from,
    to: r.e.to,
    verdict: r.e.verdict,
    taken: taken.has(`${r.e.from}>${r.e.to}`),
    back: r.e.isBack,
    stub: r.e.stub,
    points,
    labelText: r.text,
    label: labels[i],
  }));

  // The canvas holds everything that is drawn, labels included.
  let width = gapsWidth;
  let height = layoutBottom;
  for (const n of nodes) {
    width = Math.max(width, n.x + n.w + MARGIN);
    height = Math.max(height, n.y + n.h + MARGIN);
  }
  for (const e of edges) {
    for (const p of e.points) {
      width = Math.max(width, p.x + MARGIN);
      height = Math.max(height, p.y + MARGIN);
    }
    width = Math.max(width, e.label.x + e.label.w + MARGIN);
    height = Math.max(height, e.label.y + e.label.h + MARGIN);
  }
  return { nodes, edges, width: Math.ceil(width), height: Math.ceil(height) };
}

type Rect = { x: number; y: number; w: number; h: number };
const overlaps = (a: Rect, b: Rect, slack = 0) => a.x < b.x + b.w + slack && b.x < a.x + a.w + slack && a.y < b.y + b.h + slack && b.y < a.y + a.h + slack;
const segRect = (p: { x: number; y: number }, q: { x: number; y: number }): Rect => ({ x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(p.x - q.x), h: Math.abs(p.y - q.y) });

/** Does an axis-aligned segment pass through the inside of a rectangle? (Touching the border does not count.) */
export function segmentCrossesRect(p: { x: number; y: number }, q: { x: number; y: number }, r: Rect): boolean {
  const s = segRect(p, q);
  return s.x < r.x + r.w && r.x < s.x + s.w && s.y < r.y + r.h && r.y < s.y + s.h && !(s.w === 0 && (s.x <= r.x || s.x >= r.x + r.w)) && !(s.h === 0 && (s.y <= r.y || s.y >= r.y + r.h));
}

/** Gap between a chip and the line it labels. */
const CHIP_GAP = 1.5;

/**
 * Chips for the verdicts, each ON its own edge: directly above or below a horizontal segment, directly beside a vertical
 * one, so it touches it. Never over a node or another chip, and as little as possible over other edges. Chips that
 * come with a fixed spot (the failure stubs) keep it and are avoided by the others.
 */
function placeLabels(items: { w: number; points: { x: number; y: number }[]; fixed: Rect | null }[], nodes: GraphNode[]): Rect[] {
  const placed: Rect[] = items.flatMap((it) => (it.fixed ? [it.fixed] : []));
  const result: Rect[] = items.map((it) => it.fixed ?? { x: 0, y: 0, w: 0, h: LABEL_H });
  // Short edges are the tightest, so they choose first.
  const lengthOf = (pts: { x: number; y: number }[]) => pts.slice(1).reduce((s, p, i) => s + Math.abs(p.x - pts[i].x) + Math.abs(p.y - pts[i].y), 0);
  const order = items.map((_, i) => i).filter((i) => !items[i].fixed).sort((a, b) => lengthOf(items[a].points) - lengthOf(items[b].points) || a - b);
  for (const i of order) {
    const { w, points } = items[i];
    const candidates: { rect: Rect; overhang: number }[] = [];
    const segs = points.slice(1).map((p, j) => [points[j], p] as const);
    // First the segment leaving the source, then the one entering the target, then the middle ones.
    const sequence = [0, segs.length - 1, ...segs.map((_, j) => j).slice(1, -1)];
    for (const j of new Set(sequence)) {
      const [p, q] = segs[j];
      if (p.x === q.x && p.y === q.y) continue;
      const lo = Math.min(p.x, q.x);
      const hi = Math.max(p.x, q.x);
      if (p.y === q.y) {
        // Along the line: at the start the arrow leaves from, at the end it arrives at, and in the middle.
        const fromLeft = p.x < q.x;
        const xs = fromLeft ? [lo + 3, (lo + hi - w) / 2, hi - w - 3] : [hi - w - 3, (lo + hi - w) / 2, lo + 3];
        for (const x of xs) for (const y of [p.y - LABEL_H - CHIP_GAP, p.y + CHIP_GAP]) candidates.push({ rect: { x, y, w, h: LABEL_H }, overhang: Math.max(0, lo - x) + Math.max(0, x + w - hi) });
        // A segment shorter than the chip: let it stick out from the far end.
        if (hi - lo < w + 6) for (const y of [p.y - LABEL_H - CHIP_GAP, p.y + CHIP_GAP]) candidates.push({ rect: { x: lo + 3, y, w, h: LABEL_H }, overhang: Math.max(0, lo + 3 + w - hi) }, { rect: { x: hi - w - 3, y, w, h: LABEL_H }, overhang: Math.max(0, lo - (hi - w - 3)) });
      } else {
        const top = Math.min(p.y, q.y);
        const bottom = Math.max(p.y, q.y);
        const my = (top + bottom) / 2;
        for (const x of [p.x + CHIP_GAP + 1, p.x - CHIP_GAP - 1 - w]) for (const y of [my - LABEL_H / 2, top + 2, bottom - LABEL_H - 2]) candidates.push({ rect: { x, y, w, h: LABEL_H }, overhang: Math.max(0, top - y) + Math.max(0, y + LABEL_H - bottom) });
      }
    }
    let best: Rect | null = null;
    let bestCost = Infinity;
    candidates.forEach(({ rect: c, overhang }, k) => {
      if (c.x < 0 || c.y < 0) return;
      let cost = k * 0.1 + overhang * 0.2;
      cost += nodes.filter((n) => overlaps(c, n, 2)).length * 1000 + placed.filter((o) => overlaps(c, o, 2)).length * 1000;
      items.forEach((it, m) => {
        for (let t = 1; t < it.points.length; t++) if (segmentCrossesRect(it.points[t - 1], it.points[t], c)) cost += m === i ? 2 : 3;
      });
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
      }
    });
    const chosen: Rect = best ?? candidates[0].rect;
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
