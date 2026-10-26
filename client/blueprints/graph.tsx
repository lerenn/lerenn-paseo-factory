import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { buildGraph, type GraphEdge, type GraphNode, type NodeState } from "../../shared/blueprints/graph";
import type { BlueprintInfo } from "../../shared/blueprints/rpc";
import type { RunView } from "../../shared/blueprints/run";

type Theme = PluginScreenProps["theme"];

const STATE_LABEL: Record<NodeState, string> = { static: "", pending: "waiting", waiting: "waiting", running: "running", done: "done", blocked: "blocked", failed: "failed", skipped: "skipped" };

function stateColor(state: NodeState, c: Theme["colors"]): string {
  switch (state) {
    case "done":
      return c.statusSuccess;
    case "failed":
      return c.statusDanger;
    case "blocked":
    case "waiting":
      return c.statusWarning;
    case "running":
      return c.accent;
    default:
      return c.foregroundMuted;
  }
}

const THICK = 1.5;

/** One axis-aligned piece of an edge, drawn as a thin View so no SVG runtime is needed. */
function Segment({ a, b, color, opacity, width }: { a: { x: number; y: number }; b: { x: number; y: number }; color: string; opacity: number; width: number }) {
  const horizontal = a.y === b.y;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        backgroundColor: color,
        opacity,
        left: Math.min(a.x, b.x) - (horizontal ? 0 : width / 2),
        top: Math.min(a.y, b.y) - (horizontal ? width / 2 : 0),
        width: horizontal ? Math.abs(a.x - b.x) : width,
        height: horizontal ? width : Math.abs(a.y - b.y),
      }}
    />
  );
}

function Arrow({ edge, color, opacity }: { edge: GraphEdge; color: string; opacity: number }) {
  const p = edge.points;
  const last = p[p.length - 1];
  const prev = p[p.length - 2];
  const glyph = last.x > prev.x ? "▸" : last.x < prev.x ? "◂" : last.y < prev.y ? "▴" : "▾";
  const dx = glyph === "▸" ? -9 : glyph === "◂" ? -1 : -4;
  const dy = glyph === "▴" ? -1 : glyph === "▾" ? -10 : -8;
  return (
    <Text pointerEvents="none" style={{ position: "absolute", left: last.x + dx, top: last.y + dy, color, opacity, fontSize: 12, lineHeight: 14 }}>
      {glyph}
    </Text>
  );
}

function Canvas({ blueprint, run, runs, blueprints, theme, navigation, depth }: Props & { depth: number }) {
  const c = theme.colors;
  const graph = useMemo(() => buildGraph(blueprint.details, run), [blueprint, run]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const foreground = c.foreground;
  const edgeLayer = graph.edges.map((e, i) => {
    const dim = !!run && !e.taken;
    const color = e.taken ? c.accent : c.foregroundMuted;
    const opacity = dim ? 0.3 : e.taken ? 1 : 0.8;
    const width = e.taken ? THICK + 0.5 : THICK;
    return (
      <View key={`${e.from}-${e.to}-${e.verdict}-${i}`} pointerEvents="none" style={{ position: "absolute", left: 0, top: 0 }}>
        {e.points.slice(1).map((p, j) => (
          <Segment key={j} a={e.points[j]} b={p} color={color} opacity={opacity} width={width} />
        ))}
        <Arrow edge={e} color={color} opacity={opacity} />
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: e.label.x,
            top: e.label.y,
            width: e.label.w,
            height: e.label.h,
            borderRadius: 7,
            borderWidth: 1,
            borderColor: e.taken ? c.accent : c.border,
            backgroundColor: c.surface1,
            opacity: dim ? 0.6 : 1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text numberOfLines={1} style={{ color: e.taken ? foreground : c.foregroundMuted, fontSize: 10, lineHeight: 12 }}>
            {e.verdict}
          </Text>
        </View>
      </View>
    );
  });

  const node = (n: GraphNode) => {
    const color = stateColor(n.state, c);
    const dim = !!run && !n.visited;
    const clickable = !!n.agentId && !!navigation?.openAgent;
    const child = n.childBlueprint ? blueprints.find((b) => b.name === n.childBlueprint) : undefined;
    const childRun = run ? [...runs].filter((r) => r.parent?.runId === run.id && r.parent.stageId === n.id).sort((a, b) => b.createdAt - a.createdAt)[0] : undefined;
    return (
      <Pressable
        key={n.id}
        disabled={!clickable}
        onPress={() => n.agentId && navigation?.openAgent?.({ agentId: n.agentId })}
        style={{
          position: "absolute",
          left: n.x,
          top: n.y,
          width: n.w,
          height: n.h,
          borderRadius: n.kind === "terminal" ? n.h / 2 : 8,
          borderWidth: n.current ? 3 : 1,
          borderColor: n.kind === "gate" ? c.statusWarning : n.state === "static" || n.state === "pending" ? c.border : color,
          borderStyle: n.kind === "gate" || n.kind === "pm" ? "dashed" : "solid",
          backgroundColor: c.surface1,
          opacity: dim ? 0.45 : 1,
          paddingHorizontal: 8,
          paddingVertical: 4,
          justifyContent: "center",
        }}
      >
        <Text numberOfLines={1} style={{ color: foreground, fontSize: 12, fontWeight: "700", textAlign: n.kind === "terminal" ? "center" : "left" }}>
          {n.kind === "gate" ? "? " : ""}
          {n.label}
        </Text>
        {n.kind !== "terminal" ? (
          <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 10 }}>
            {n.kind === "gate" ? "Inbox question" : n.kind === "pm" ? "PM judgement" : n.kind === "blueprint" ? `run ${n.childBlueprint ?? "blueprint"}` : n.kind === "call" ? "tool call" : (n.role ?? "")}
          </Text>
        ) : null}
        {n.state !== "static" && n.kind !== "terminal" ? (
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
            <Text style={{ color, fontSize: 10, fontWeight: "700" }}>{STATE_LABEL[n.state]}</Text>
            {n.retries > 0 ? <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>↻ {n.retries}</Text> : null}
            {clickable ? <Text style={{ color: c.accent, fontSize: 10 }}>open ↗</Text> : null}
          </View>
        ) : null}
        {n.kind === "blueprint" && (child || childRun) && depth < 2 ? (
          <Pressable onPress={() => setOpen((o) => ({ ...o, [n.id]: !o[n.id] }))} style={{ position: "absolute", right: 6, top: 2 }}>
            <Text style={{ color: c.accent, fontSize: 11 }}>{open[n.id] ? "▾" : "▸"}</Text>
          </Pressable>
        ) : null}
      </Pressable>
    );
  };

  const nested = graph.nodes.filter((n) => n.kind === "blueprint" && open[n.id]);
  return (
    <View style={{ gap: 8 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View style={{ width: graph.width, height: graph.height }}>
          {edgeLayer}
          {graph.nodes.map(node)}
        </View>
      </ScrollView>
      {nested.map((n) => {
        const childRun = run ? [...runs].filter((r) => r.parent?.runId === run.id && r.parent.stageId === n.id).sort((a, b) => b.createdAt - a.createdAt)[0] : undefined;
        const child = blueprints.find((b) => b.name === (childRun?.blueprint ?? n.childBlueprint));
        if (!child) return null;
        return (
          <View key={n.id} style={{ borderLeftWidth: 2, borderLeftColor: c.border, paddingLeft: 8, gap: 4 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
              {n.id} → {child.name}
              {childRun ? ` (${childRun.id}, ${childRun.status})` : " (not started)"}
            </Text>
            <Canvas blueprint={child} run={childRun ?? null} runs={runs} blueprints={blueprints} theme={theme} navigation={navigation} depth={depth + 1} />
          </View>
        );
      })}
    </View>
  );
}

interface Props {
  blueprint: BlueprintInfo;
  /** The run to overlay; null shows the blueprint's static shape. */
  run: RunView | null;
  /** All runs, to find the child runs of blueprint stages. */
  runs: RunView[];
  blueprints: BlueprintInfo[];
  theme: Theme;
  navigation?: PluginScreenProps["navigation"];
}

/** Flows: blueprint execution as a graph: stages as nodes, verdict transitions as edges, the path taken highlighted. */
export function BlueprintGraph(props: Props) {
  return <Canvas {...props} depth={0} />;
}
