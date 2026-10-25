import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listRunsRpc, spendRpc } from "../shared/blueprints/rpc";
import { listItemsRpc } from "../shared/inbox/rpc";
import { listLeasesRpc } from "../shared/leases/rpc";
import { overviewRpc } from "../shared/rpc";
import { listRoleAgentsRpc, listRolesRpc } from "../shared/roles/rpc";
import { listTasksRpc } from "../shared/warden/rpc";

const POLL = 5_000;
const STALLED_MS = 30 * 60_000;

/** A poll that may fail (module off, plugin starting) without breaking the dashboard. */
function soft<T>(key: string, fn: () => Promise<T>) {
  return { queryKey: ["factory", "overview", key], queryFn: fn, refetchInterval: POLL, retry: false } as const;
}

const ago = (now: number, at: number) => {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const usd = (v: number) => `$${v.toFixed(2)}`;
const inMin = (now: number, at: number) => `${Math.max(0, Math.round((at - now) / 60_000))}m`;

export function OverviewScreen({ theme, layout, go }: Pick<PluginScreenProps, "theme" | "layout"> & { go(tab: string): void }) {
  const c = theme.colors;
  const callFactory = useRpc(overviewRpc);
  const callRuns = useRpc(listRunsRpc);
  const callInbox = useRpc(listItemsRpc);
  const callLeases = useRpc(listLeasesRpc);
  const callWarden = useRpc(listTasksRpc);
  const callRoles = useRpc(listRolesRpc);
  const callAgents = useRpc(listRoleAgentsRpc);
  const callSpend = useRpc(spendRpc);
  const factory = useQuery(soft("factory", () => callFactory({})));
  const runs = useQuery(soft("runs", () => callRuns({ includeFinished: true })));
  const inbox = useQuery(soft("inbox", () => callInbox({})));
  const leases = useQuery(soft("leases", () => callLeases({})));
  const warden = useQuery(soft("warden", () => callWarden({})));
  const roles = useQuery(soft("roles", () => callRoles({})));
  const agents = useQuery(soft("agents", () => callAgents({})));
  const spend = useQuery(soft("spend", () => callSpend({ days: 30 })));
  const on = (id: "blueprints" | "inbox" | "leases" | "warden" | "roles") => factory.data?.settings?.modules[id] ?? true;
  const now = runs.data?.now ?? inbox.data?.now ?? Date.now();

  const card = (title: string, tab: string, summary: string, body: ReactNode, tone: "ok" | "warn" = "ok") => (
    <Pressable
      key={title}
      onPress={() => go(tab)}
      style={{ flexGrow: 1, flexBasis: layout.compact ? "100%" : 320, padding: 12, gap: 6, borderRadius: 10, borderWidth: 1, borderColor: tone === "warn" ? c.statusWarning : c.border, backgroundColor: c.surface1 }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: c.foreground, fontWeight: "700" }}>{title}</Text>
        <Text style={{ color: tone === "warn" ? c.statusWarning : c.foregroundMuted, fontSize: 12 }}>{summary}</Text>
      </View>
      {body}
    </Pressable>
  );
  const line = (text: string, key?: string, color?: string) => (
    <Text key={key ?? text} numberOfLines={1} style={{ color: color ?? c.foregroundMuted, fontSize: 12 }}>
      {text}
    </Text>
  );

  const allRuns = runs.data?.runs ?? [];
  const active = allRuns.filter((r) => r.endedAt === null);
  const bad = (r: (typeof active)[number]) => r.pmPending !== null || r.status === "paused" || (r.status === "running" && now - r.updatedAt > STALLED_MS);
  const pending = (inbox.data?.items ?? []).filter((i) => i.status === "pending");
  const held = (leases.data?.leases ?? []).filter((l) => l.holder);
  const queued = (leases.data?.leases ?? []).reduce((n, l) => n + l.queue.length, 0);
  const attention = (warden.data?.tasks ?? []).filter((t) => t.status !== "ok" && !["done", "expired", "archived", "cancelled"].includes(t.status) || t.needAttention > 0);
  const nextPings = (warden.data?.tasks ?? []).filter((t) => t.nextPing).sort((a, b) => a.nextPing!.at - b.nextPing!.at).slice(0, 3);
  const byRole = new Map<string, number>();
  for (const a of agents.data?.agents ?? []) byRole.set(a.role, (byRole.get(a.role) ?? 0) + 1);
  const git = roles.data?.git ?? [];
  const exts = factory.data?.extensions ?? [];

  const feed = [
    ...allRuns.flatMap((r) => r.history.filter((h) => ["started", "done", "failed", "aborted", "gate_opened", "gate_answered", "pm_grant", "pm_rescope", "exhausted", "head_moved", "merged"].includes(h.event)).map((h) => ({ at: h.at, text: `${r.blueprint} ${r.vars.ticket || r.id}: ${h.event}${h.stage ? ` · ${h.stage}` : ""}`, bad: ["failed", "exhausted", "aborted"].includes(h.event) }))),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 12);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 10 : 16, gap: 10 }}>
      <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "600" }}>Overview</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {on("blueprints")
          ? card(
              "Blueprint runs",
              "blueprints",
              `${active.length} active${active.some(bad) ? " · needs a look" : ""}`,
              <>
                {active.length === 0 ? line("No active run.") : null}
                {active.slice(0, 5).map((r) => line(`${bad(r) ? "⚠ " : ""}${r.blueprint} ${r.vars.ticket || r.id} · ${r.stage ?? "-"}${r.pmPending ? " · PM judgement pending" : r.waitingFor ? ` · ${r.waitingFor}` : ""}`, r.id, bad(r) ? c.statusWarning : undefined))}
              </>,
              active.some(bad) ? "warn" : "ok",
            )
          : null}
        {on("inbox")
          ? card(
              "Inbox",
              "inbox",
              `${pending.length} pending`,
              <>
                {pending.length === 0 ? line("Nothing waits for you.") : null}
                {pending.slice(0, 5).map((i) => line(`${i.question} · ${i.agentTitle ?? i.agentId} · ${ago(now, i.createdAt)}`, i.id))}
              </>,
              pending.length > 0 ? "warn" : "ok",
            )
          : null}
        {on("leases")
          ? card(
              "Leases",
              "leases",
              `${held.length} held · ${queued} queued`,
              <>
                {held.length === 0 ? line("No lease held.") : null}
                {held.slice(0, 5).map((l) => line(`${l.name} · ${l.holder!.agentTitle ?? l.holder!.agentId} · expires in ${inMin(now, l.holder!.expiresAt)}${l.queue.length ? ` · ${l.queue.length} waiting` : ""}`, l.name))}
              </>,
            )
          : null}
        {on("warden")
          ? card(
              "Warden",
              "warden",
              `${warden.data?.tasks.length ?? 0} watched${attention.length ? ` · ${attention.length} need attention` : ""}`,
              <>
                {attention.slice(0, 3).map((t) => line(`⚠ ${t.agentTitle ?? t.agentId}: ${t.task}`, `a${t.id}`, c.statusWarning))}
                {nextPings.map((t) => line(`next ping in ${inMin(now, t.nextPing!.at)} · ${t.agentTitle ?? t.agentId}`, `n${t.id}`))}
                {attention.length === 0 && nextPings.length === 0 ? line("Nothing watched.") : null}
              </>,
              attention.length > 0 ? "warn" : "ok",
            )
          : null}
        {on("roles")
          ? card(
              "Role agents",
              "roles",
              `${agents.data?.agents.length ?? 0} live`,
              <>
                {byRole.size === 0 ? line("No agent running with a role.") : null}
                {[...byRole.entries()].sort().map(([role, n]) => line(`${role}: ${n}`, role))}
              </>,
            )
          : null}
        {on("roles")
          ? card(
              "Git sync",
              "settings",
              git.length ? (git.some((g) => g.error) ? "errors" : "ok") : "no source",
              <>
                {git.length === 0 ? line("Add a git source in Settings.") : null}
                {git.map((g) => line(`${g.label}: ${g.error ? `failed (${g.error})` : g.lastSync ? `synced ${ago(now, Date.parse(g.lastSync))}` : "not synced yet"}`, g.id, g.error ? c.statusDanger : undefined))}
              </>,
              git.some((g) => g.error) ? "warn" : "ok",
            )
          : null}
        {on("blueprints") && spend.data
          ? card(
              "Spend (30 days)",
              "blueprints",
              usd(spend.data.total.costUsd),
              <>
                {spend.data.total.turns === 0 ? line("No factory agent usage recorded yet.") : null}
                {spend.data.byDay.slice(0, 3).map((d) => line(`${d.key}: ${usd(d.costUsd)} · ${d.turns} turns`, `d${d.key}`))}
                {spend.data.byRole.slice(0, 3).map((r) => line(`role ${r.key}: ${usd(r.costUsd)}`, `r${r.key}`))}
                {spend.data.byRun.slice(0, 3).map((r) => line(`${r.blueprint ?? ""} ${r.key}: ${usd(r.costUsd)}`, `u${r.key}`))}
              </>,
            )
          : null}
        {exts.length > 0
          ? card(
              "Extensions",
              `ext:${exts[0].id}`,
              exts.every((e) => e.health === "ok") ? "all reachable" : "some unreachable",
              exts.map((e) => line(`${e.health === "ok" ? "●" : "○"} ${e.tab ?? e.id} v${e.version}`, e.id, e.health === "ok" ? undefined : c.statusWarning)),
              exts.some((e) => e.health !== "ok") ? "warn" : "ok",
            )
          : null}
      </View>
      <View style={{ padding: 12, gap: 4, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
        <Text style={{ color: c.foreground, fontWeight: "700" }}>Recent activity</Text>
        {feed.length === 0 ? line("Nothing yet.") : feed.map((f, i) => line(`${ago(now, f.at)} · ${f.text}`, `${f.at}-${i}`, f.bad ? c.statusDanger : undefined))}
      </View>
    </ScrollView>
  );
}
