import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { forceReleaseRpc, listLeasesRpc } from "../../shared/leases/rpc";
import type { LeaseView } from "../../shared/leases/lease";
import { inTime } from "./format";

type Tab = "leases" | "audit";

const who = (id: string, title: string | null) => (title ? `${title} (${id.slice(0, 8)})` : id);

// The header host picker is supplied by Paseo, so the title carries no host suffix.
export function LeasesScreen({ theme, layout }: PluginScreenProps) {
  const list = useRpc(listLeasesRpc);
  const releaseCall = useRpc(forceReleaseRpc);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("leases");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({ queryKey: ["leases", "list", tab === "audit"], queryFn: () => list({ audit: tab === "audit" }), refetchInterval: 5_000 });
  const release = useMutation({
    mutationFn: (name: string) => releaseCall({ name }),
    onSuccess: (r) => {
      setError(r.ok ? null : r.message);
      setConfirm(null);
      void queryClient.invalidateQueries({ queryKey: ["leases"] });
    },
  });

  const s = useMemo(() => {
    const c = theme.colors;
    const pad = layout.compact ? 10 : 20;
    return {
      screen: { flex: 1, backgroundColor: c.surface0 },
      body: { padding: pad, gap: 6 },
      h: { color: c.foreground, fontSize: layout.compact ? 17 : 20, fontWeight: "600" as const },
      muted: { color: c.foregroundMuted, fontSize: 12 },
      text: { color: c.foreground, fontSize: 14 },
      tabs: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginVertical: 4 },
      tab: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border },
      row: { borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, padding: 10, gap: 4 },
      line: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      button: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 },
    };
  }, [theme, layout.compact]);

  const data = query.data;
  const now = data?.now ?? Date.now();

  const renderLease = (lease: LeaseView) => (
    <View key={lease.name} style={s.row}>
      <View style={s.line}>
        <Text style={[s.text, { fontWeight: "700", flexShrink: 1 }]} selectable>{lease.name}</Text>
        <Text style={s.muted}>handover {lease.handover}</Text>
      </View>
      {lease.holder ? (
        <>
          <Text style={s.text} selectable>
            Held by {who(lease.holder.agentId, lease.holder.agentTitle)} · {lease.holder.mode} · expires {inTime(now, lease.holder.expiresAt)} ({new Date(lease.holder.expiresAt).toLocaleTimeString()})
          </Text>
          {lease.queue.length > 0 ? (
            <Text style={s.muted} selectable>
              Waiting: {lease.queue.map((w, i) => `${i + 1}. ${who(w.agentId, w.agentTitle)}`).join(" · ")}
            </Text>
          ) : null}
          <View style={s.line}>
            {confirm === lease.name ? (
              <>
                <Pressable accessibilityRole="button" accessibilityLabel={`Confirm force release of ${lease.name}`} disabled={release.isPending} onPress={() => release.mutate(lease.name)} style={[s.button, { borderColor: theme.colors.statusDanger }]}>
                  <Text style={s.text}>Confirm: the holder loses it</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setConfirm(null)} style={s.button}>
                  <Text style={s.text}>Cancel</Text>
                </Pressable>
              </>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel={`Force release ${lease.name}`} onPress={() => setConfirm(lease.name)} style={s.button}>
                <Text style={s.text}>Force release</Text>
              </Pressable>
            )}
          </View>
        </>
      ) : (
        <Text style={s.muted}>Free; {lease.queue.length} waiting</Text>
      )}
    </View>
  );

  const tabs: { id: Tab; label: string }[] = [
    { id: "leases", label: `Leases${data?.leases.length ? ` (${data.leases.length})` : ""}` },
    { id: "audit", label: "Audit" },
  ];

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      <Text style={s.h}>Agents Leases</Text>
      <View style={s.tabs}>
        {tabs.map((t) => (
          <Pressable key={t.id} accessibilityRole="button" accessibilityLabel={t.label} onPress={() => setTab(t.id)} style={[s.tab, tab === t.id ? { backgroundColor: theme.colors.surface2 } : null]}>
            <Text style={s.text}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {query.isError ? <Text style={s.muted}>Could not load: {String(query.error)}</Text> : null}
      {data?.endpoint.error ? <Text style={s.text}>{data.endpoint.error}</Text> : null}
      {data?.settingsError ? <Text style={s.text}>Invalid settings: {data.settingsError}</Text> : null}
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
      {tab === "leases" ? (
        <>
          {data && data.leases.length === 0 ? <Text style={s.muted}>No active leases. Agents take them with lease_acquire.</Text> : null}
          {data?.leases.map(renderLease)}
        </>
      ) : (
        <>
          {data && data.events.length === 0 ? <Text style={s.muted}>No events yet.</Text> : null}
          {[...(data?.events ?? [])].reverse().map((e, i) => (
            <Text key={`${e.at}-${i}`} style={s.muted} selectable>
              {new Date(e.at).toLocaleString()} · {e.type} · {e.lease} · {e.actor}
              {e.detail ? ` · ${e.detail}` : ""}
            </Text>
          ))}
        </>
      )}
      <Text style={s.muted}>Edit scope, timings and message templates under Settings → Plugins → Agents Leases.</Text>
    </ScrollView>
  );
}
