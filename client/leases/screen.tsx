import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { forceReleaseRpc, listLeasesRpc } from "../../shared/leases/rpc";
import type { LeaseView } from "../../shared/leases/lease";
import { inTime } from "./format";
import { CollapsibleRow } from "../collapsible-row";
import { LEASES_FIELDS, ModuleSettings } from "../module-settings";
import { SubTabs } from "../subtabs";
import { leasesSettings } from "../../shared/leases/settings";


const who = (id: string, title: string | null) => (title ? `${title} (${id.slice(0, 8)})` : id);

// The header host picker is supplied by Paseo, so the title carries no host suffix.
export function LeasesScreen({ theme, layout }: PluginScreenProps) {
  const list = useRpc(listLeasesRpc);
  const releaseCall = useRpc(forceReleaseRpc);
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({ queryKey: ["leases", "list"], queryFn: () => list({ audit: true }), refetchInterval: 5_000 });
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

  const renderLease = (lease: LeaseView) => {
    const c = theme.colors;
    const holder = lease.holder;
    const pill = holder ? { text: "held", color: c.statusSuccess } : { text: lease.queue.length ? "queued" : "free", color: c.statusWarning };
    return (
      <CollapsibleRow
        key={lease.name}
        theme={theme}
        pill={pill}
        title={lease.name}
        bold
        parts={[
          holder ? (holder.agentTitle ?? holder.agentId.slice(0, 8)) : null,
          holder ? `expires ${inTime(now, holder.expiresAt)}` : null,
          lease.queue.length ? `${lease.queue.length} waiting` : null,
        ]}
      >
        <Text style={s.muted}>Handover token {lease.handover}</Text>
        {holder ? (
          <>
            <Text style={s.text} selectable>
              Held by {who(holder.agentId, holder.agentTitle)} · {holder.mode} · ttl {holder.ttlSeconds} s · expires {inTime(now, holder.expiresAt)} ({new Date(holder.expiresAt).toLocaleTimeString()})
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
      </CollapsibleRow>
    );
  };

  const status = (
    <>
      {query.isError ? <Text style={s.muted}>Could not load: {String(query.error)}</Text> : null}
      {data?.endpoint.error ? <Text style={s.text}>{data.endpoint.error}</Text> : null}
      {data?.settingsError ? <Text style={s.text}>Invalid settings: {data.settingsError}</Text> : null}
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
    </>
  );
  const page = (children: React.ReactNode) => (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      {children}
    </ScrollView>
  );

  return (
    <View style={s.screen}>
      <Text style={[s.h, { paddingHorizontal: layout.compact ? 10 : 20, paddingTop: 12 }]}>Leases</Text>
      <SubTabs
        theme={theme}
        tabs={[
          {
            key: "held",
            label: "Held",
            badge: data?.leases.length,
            render: () =>
              page(
                <>
                  {status}
                  {data && data.leases.length === 0 ? <Text style={s.muted}>No active leases. Agents take them with lease_acquire.</Text> : null}
                  {data?.leases.map(renderLease)}
                </>,
              ),
          },
          {
            key: "rules",
            label: "Rules",
            render: () =>
              page(
                <>
                  <Text style={s.text}>A lease is a name held by one agent for a TTL (seconds). The holder renews before it expires and releases when done; a handover token changes with every new holder, so a stale renew is refused. Names are agreed between roles; these are the conventions of the lab roles:</Text>
                  {RULES.map((r) => (
                    <View key={r.name} style={[s.row, { gap: 2 }]}>
                      <Text style={[s.text, { fontWeight: "700" }]} selectable>{r.name}</Text>
                      <Text style={s.muted}>{r.mode} mode · ttl {r.ttl} · {r.when}</Text>
                    </View>
                  ))}
                  <Text style={s.muted}>queue: a busy lease queues you; you are woken with "Agents Leases:" when it is yours. takeover: the newest request wins and the previous holder is told it lost the lease (it must stop at once). Renew with the same ttl at least every third of it, and before ending a turn to wait. Leases are released automatically when the holder is archived.</Text>
                </>,
              ),
          },
          {
            key: "audit",
            label: "Audit",
            render: () =>
              page(
                <>
                  {data && data.events.length === 0 ? <Text style={s.muted}>No events yet.</Text> : null}
                  {[...(data?.events ?? [])].reverse().map((e, i) => (
                    <Text key={`${e.at}-${i}`} style={s.muted} selectable>
                      {new Date(e.at).toLocaleString()} · {e.type} · {e.lease} · {e.actor}
                      {e.detail ? ` · ${e.detail}` : ""}
                    </Text>
                  ))}
                </>,
              ),
          },
          { key: "settings", label: "Settings", render: () => <ModuleSettings theme={theme} definition={leasesSettings} fields={LEASES_FIELDS} title="Leases settings" /> },
        ]}
      />
    </View>
  );
}

const RULES = [
  { name: "pr:<owner>/<repo>#<number>@<head sha>", mode: "takeover", ttl: "900 s", when: "before pushing to or babysitting a PR; re-taken for the new head after each push" },
  { name: "qa:<ticket>", mode: "takeover", ttl: "1800 s", when: "before a local QA run, one per ticket; renew at least every 10 min" },
  { name: "release:<open|dev|stg|prd>", mode: "queue", ttl: "1800 s (4 h while waiting for a merge)", when: "first thing in a releaser job" },
];
