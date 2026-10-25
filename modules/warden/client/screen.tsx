import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { cancelTaskRpc, listTasksRpc } from "../shared/rpc";
import type { TaskStatus, TaskView } from "../shared/task";

function ago(now: number, at: number | null): string {
  if (at === null) return "never";
  const min = Math.max(0, Math.round((now - at) / 60_000));
  return min < 1 ? "just now" : min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

function nextPingLine(t: Pick<TaskView, "status" | "nextPing">, now: number): string {
  if (!ACTIVE.includes(t.status) || !t.nextPing) return "no ping scheduled";
  const min = Math.max(0, Math.ceil((t.nextPing.at - now) / 60_000));
  return `next ping in ${min}m (${t.nextPing.reason})`;
}

function turnLabel(t: Pick<TaskView, "turn" | "idleSince">, now: number): string {
  switch (t.turn) {
    case "running":
      return "running";
    case "idle":
      return `idle since ${t.idleSince ? Math.max(0, Math.round((now - t.idleSince) / 60_000)) : 0}m`;
    case "waiting-permission":
      return "waiting for permission";
    default:
      return "turn state unknown";
  }
}

const ACTIVE: TaskStatus[] = ["ok", "pinged", "escalated", "waiting-permission"];

interface CardData {
  key: string;
  headline: string;
  status: TaskStatus;
  projectName: string | null;
  workspaceName: string | null;
  agentTitle: string | null;
  agentId: string;
  turn: string;
  rule: string;
  subagents: string | null;
  nextPing: string;
  lastActivityAt: number;
  pings: number;
  unanswered: number;
  registeredBy: string;
  until: number | null;
  extra: string[];
  active: boolean;
  stopLabel: string;
  onStop: () => void;
}

type Colors = PluginScreenProps["theme"]["colors"];

/** Badge color per status, taken from the theme so it works in every theme. */
function badgeColor(status: TaskStatus, c: Colors): string {
  switch (status) {
    case "ok":
      return c.statusSuccess;
    case "pinged":
      return c.statusWarning;
    case "escalated":
    case "gave-up":
      return c.statusDanger;
    case "waiting-permission":
      return c.accent;
    case "done":
      return c.statusSuccess;
    default:
      return c.foregroundMuted;
  }
}

/** Soft tinted background for a #rrggbb color; other formats fall back to no fill. */
function tint(color: string, alpha: string): string | undefined {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : undefined;
}

function StatusBadge({ status, styles, colors }: { status: TaskStatus; styles: any; colors: Colors }) {
  const color = badgeColor(status, colors);
  const fill = tint(color, "26");
  return (
    <View accessibilityLabel={`Status: ${status}`} style={[styles.badge, { borderColor: tint(color, "66") ?? color }, fill ? { backgroundColor: fill } : null]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]}>{status}</Text>
    </View>
  );
}

/** Chevron header that shows its children only while open; closed by default. */
function Collapsible({ title, summary, styles, children }: { title: string; summary?: string; styles: any; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={title} onPress={() => setOpen((v) => !v)}>
        <Text style={styles.h}>
          {open ? "▾" : "▸"} {title}
          {summary ? ` · ${summary}` : ""}
        </Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

export function WardenScreen({ theme, layout, navigation }: PluginScreenProps) {
  const list = useRpc(listTasksRpc);
  const cancel = useRpc(cancelTaskRpc);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["warden", "tasks"], queryFn: () => list({}), refetchInterval: 10_000 });
  const stop = useMutation({
    mutationFn: (taskId: string) => cancel({ taskId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["warden", "tasks"] }),
  });

  const s = useMemo(() => {
    const color = theme.colors;
    const pad = layout.compact ? 12 : 20;
    return {
      screen: { flex: 1, backgroundColor: color.surface0 },
      body: { padding: pad, gap: 12 },
      h: { color: color.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "600" as const },
      muted: { color: color.foregroundMuted, fontSize: 13 },
      text: { color: color.foreground, fontSize: 14 },
      card: { padding: 12, gap: 4, borderRadius: 10, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface1 },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
      badge: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingVertical: 2, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, alignSelf: "flex-start" as const },
      dot: { width: 7, height: 7, borderRadius: 4 },
      badgeText: { fontSize: 12, fontWeight: "600" as const },
      button: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: color.border },
    };
  }, [theme, layout.compact]);

  const data = query.data;
  const tasks = [...(data?.tasks ?? [])].sort((a, b) => Number(ACTIVE.includes(b.status)) - Number(ACTIVE.includes(a.status)) || b.lastActivityAt - a.lastActivityAt);
  const finished = tasks.filter((t) => !ACTIVE.includes(t.status));
  const settings = data?.settings;

  const openAgent = navigation?.openAgent;

  /** One card layout for every watch, whether an agent registered a task or the user asked to supervise. */
  const renderCard = (c: CardData) => (
    <View key={c.key} style={s.card}>
      <View style={s.row}>
        <Text style={[s.text, { flex: 1 }]}>{c.headline}</Text>
        <StatusBadge status={c.status} styles={s} colors={theme.colors} />
      </View>
      <Text style={s.muted}>
        {[c.projectName, c.workspaceName].filter(Boolean).join(" › ") || "Unknown workspace"}
        {" · "}
        {c.agentTitle ?? "Untitled conversation"}
      </Text>
      {openAgent ? (
        <Pressable accessibilityRole="link" accessibilityLabel={`Open agent ${c.agentTitle ?? c.agentId}`} onPress={() => openAgent({ agentId: c.agentId })}>
          <Text style={[s.muted, { color: theme.colors.accent, textDecorationLine: "underline" as const }]}>Agent {c.agentId}</Text>
        </Pressable>
      ) : (
        <Text style={s.muted} selectable>
          Agent {c.agentId}
        </Text>
      )}
      <Text style={s.muted}>
        {c.turn} · {c.rule} · last activity {ago(data!.now, c.lastActivityAt)}
      </Text>
      {c.subagents ? <Text style={s.muted}>{c.subagents}</Text> : null}
      <Text style={s.muted}>{c.nextPing}</Text>
      <Text style={s.muted}>
        {c.pings} pings sent ({c.unanswered} unanswered) · registered by {c.registeredBy}
        {c.until ? ` · until ${new Date(c.until).toLocaleString()}` : ""}
      </Text>
      {c.extra.map((line, i) => (
        <Text key={i} style={s.muted}>
          {line}
        </Text>
      ))}
      {c.active ? (
        <View style={s.row}>
          <View />
          <Pressable accessibilityRole="button" accessibilityLabel={c.stopLabel} onPress={c.onStop} style={s.button}>
            <Text style={s.text}>Stop</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  const taskCard = (t: TaskView): CardData => ({
    key: t.id,
    headline: t.task,
    status: t.status,
    projectName: t.projectName,
    workspaceName: t.workspaceName,
    agentTitle: t.agentTitle,
    agentId: t.agentId,
    turn: turnLabel(t, data!.now),
    rule: `pings ${settings ? Math.max(1, Math.round(settings.idleGraceSeconds / 60)) : 1} min after it stops · hang check ${t.intervalMinutes} min`,
    subagents: t.children > 0 ? `${t.children} subagent${t.children > 1 ? "s" : ""} · ${t.needAttention} need attention` : null,
    nextPing: nextPingLine(t, data!.now),
    lastActivityAt: t.lastActivityAt,
    pings: t.pings,
    unanswered: t.unanswered,
    registeredBy: `${t.registeredBy === t.agentId ? "the agent" : t.registeredBy === "user" ? "the user" : t.registeredBy} (${t.source})`,
    until: t.until,
    extra: [...(t.notes.length > 0 ? [`Last note: ${t.notes[t.notes.length - 1].text}`] : []), ...(t.result ? [`Result: ${t.result}`] : [])],
    active: ACTIVE.includes(t.status),
    stopLabel: `Stop watching ${t.task}`,
    onStop: () => stop.mutate(t.id),
  });

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      <Text style={s.h}>Watched tasks</Text>
      {query.isError ? <Text style={s.muted}>Could not load: {String(query.error)}</Text> : null}
      {data?.endpoint.error ? <Text style={s.text}>{data.endpoint.error}</Text> : null}
      {data && tasks.length === 0 ? (
        <Text style={s.muted}>No tasks yet. Agents register them with warden_register; a parent can use warden_register_subagent.</Text>
      ) : null}
      {tasks.filter((t) => ACTIVE.includes(t.status)).map((t) => renderCard(taskCard(t)))}
      {finished.length > 0 ? (
        <Collapsible title="Finished tasks" summary={`${finished.length}`} styles={s}>
          {finished.map((t) => renderCard(taskCard(t)))}
        </Collapsible>
      ) : null}
      <Collapsible title="Settings" summary={settings ? (settings.scope === "all" ? "all agents" : "opt-in") : undefined} styles={s}>
      {data?.settingsError ? <Text style={s.text}>Invalid settings: {data.settingsError}</Text> : null}
      {settings ? (
        <View style={s.card}>
          <Text style={s.muted}>Tools for: {settings.scope === "all" ? "all agents (PASEO_WARDEN=off opts out)" : "agents created with PASEO_WARDEN=on"}</Text>
          <Text style={s.muted}>At most one prompt every {settings.globalGapSeconds} s across agents</Text>
          <Text style={s.muted}>Hang backstop capped at {settings.maxIntervalMinutes} min; backoff x{settings.backoffFactor} up to {settings.maxBackoffIntervals} intervals; parent notified after {settings.notifyParentAfterPings} unanswered pings; give up after {settings.maxUnansweredPings}</Text>
          <Text style={s.muted}>Announced-work detection: {settings.announcedWork.enabled ? `on (every ${settings.announcedWork.intervalMinutes} min)` : "off"}</Text>
          <Text style={s.muted}>Edit these under Settings → Plugins → Agents Warden.</Text>
        </View>
      ) : null}
      </Collapsible>
    </ScrollView>
  );
}
