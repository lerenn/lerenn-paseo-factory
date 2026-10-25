import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { activityRpc, type ActivityEntry } from "../shared/rpc";

const TYPES: ActivityEntry["type"][] = ["run", "stage", "gate", "escalation", "lease", "merge", "deploy", "inbox", "extension"];

const ago = (now: number, at: number) => {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

/** Pure filter, exported for tests. Empty selections mean "all". */
export function filterActivity(items: ActivityEntry[], f: { types: string[]; blueprint: string | null; role: string | null }): ActivityEntry[] {
  return items.filter((i) => (f.types.length === 0 || f.types.includes(i.type)) && (!f.blueprint || i.blueprint === f.blueprint) && (!f.role || i.role === f.role));
}

/** The factory-wide feed, newest first. Read-only; a row's link opens the tab it belongs to. */
export function ActivityScreen({ theme, layout, go }: Pick<PluginScreenProps, "theme" | "layout"> & { go(tab: string): void }) {
  const c = theme.colors;
  const call = useRpc(activityRpc);
  const q = useQuery({ queryKey: ["factory", "activity"], queryFn: () => call({ limit: 300 }), refetchInterval: 5_000 });
  const [types, setTypes] = useState<string[]>([]);
  const [blueprint, setBlueprint] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  const now = q.data?.now ?? Date.now();
  const blueprints = useMemo(() => [...new Set(items.map((i) => i.blueprint).filter((x): x is string => !!x))].sort(), [items]);
  const roles = useMemo(() => [...new Set(items.map((i) => i.role).filter((x): x is string => !!x))].sort(), [items]);
  const shown = filterActivity(items, { types, blueprint, role });
  const tone = (t: string) => (t === "escalation" ? c.statusWarning : t === "merge" || t === "deploy" ? c.statusSuccess : c.foregroundMuted);

  const chip = (key: string, label: string, active: boolean, onPress: () => void) => (
    <Pressable key={key} onPress={onPress} style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 10, borderWidth: 1, borderColor: active ? c.accent : c.border }}>
      <Text style={{ color: active ? c.foreground : c.foregroundMuted, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 10 : 16, gap: 8 }}>
      <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "600" }}>Activity</Text>
      {q.isError ? <Text style={{ color: c.statusDanger }}>Could not load: {String(q.error)}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {TYPES.map((t) => chip(t, t, types.includes(t), () => setTypes((l) => (l.includes(t) ? l.filter((x) => x !== t) : [...l, t]))))}
      </View>
      {blueprints.length > 0 ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{blueprints.map((b) => chip(`b${b}`, `blueprint ${b}`, blueprint === b, () => setBlueprint(blueprint === b ? null : b)))}</View> : null}
      {roles.length > 0 ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{roles.map((r) => chip(`r${r}`, `role ${r}`, role === r, () => setRole(role === r ? null : r)))}</View> : null}
      {q.data && shown.length === 0 ? <Text style={{ color: c.foregroundMuted }}>Nothing matches.</Text> : null}
      {shown.map((i, n) => (
        <Pressable key={`${i.at}-${n}`} disabled={!i.link} onPress={() => i.link && go(i.link.tab)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12, width: 64 }}>{ago(now, i.at)}</Text>
          <View style={{ paddingVertical: 1, paddingHorizontal: 8, borderRadius: 10, borderWidth: 1, borderColor: tone(i.type) }}>
            <Text style={{ color: tone(i.type), fontSize: 11, fontWeight: "700" }}>{i.type}</Text>
          </View>
          <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 13, flexShrink: 1 }}>
            {i.title}
            {i.detail ? <Text style={{ color: c.foregroundMuted }}>{` · ${i.detail.length > 80 ? `${i.detail.slice(0, 79)}…` : i.detail}`}</Text> : null}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
