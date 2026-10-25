import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { answerRpc, listItemsRpc, readRpc } from "../../shared/inbox/rpc";
import type { ItemStatus, ItemView } from "../../shared/inbox/item";

type Tab = "pending" | "answered" | "audit";
type Colors = PluginScreenProps["theme"]["colors"];

function ago(now: number, at: number | null): string {
  if (at === null) return "never";
  const min = Math.max(0, Math.round((now - at) / 60_000));
  return min < 1 ? "just now" : min < 90 ? `${min} min ago` : min < 2880 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
}

function statusIcon(status: ItemStatus, c: Colors): { glyph: string; color: string; label: string } {
  switch (status) {
    case "pending":
      return { glyph: "⏳", color: c.statusWarning, label: "Pending" };
    case "answered":
      return { glyph: "✓", color: c.statusSuccess, label: "Answered" };
    case "expired":
      return { glyph: "⏱", color: c.statusDanger, label: "Expired" };
    case "withdrawn":
      return { glyph: "↩", color: c.foregroundMuted, label: "Withdrawn" };
    default:
      return { glyph: "▣", color: c.foregroundMuted, label: "Archived" };
  }
}

export function InboxScreen({ theme, layout }: PluginScreenProps) {
  const list = useRpc(listItemsRpc);
  const answerCall = useRpc(answerRpc);
  const readCall = useRpc(readRpc);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("pending");
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const key = ["inbox", "items", tab === "audit"];
  const query = useQuery({ queryKey: key, queryFn: () => list({ audit: tab === "audit" }), refetchInterval: 10_000 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["inbox"] });
  const answer = useMutation({
    mutationFn: (v: { itemId: string; optionId?: string; text?: string }) => answerCall(v),
    onSuccess: (r) => {
      setError(r.ok ? null : r.message);
      void refresh();
    },
  });
  const read = useMutation({ mutationFn: (itemId: string) => readCall({ itemId }), onSuccess: () => void refresh() });

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
      row: { borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 8, paddingHorizontal: 10 },
      detail: { gap: 6, paddingHorizontal: 10, paddingBottom: 10 },
      choices: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      button: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 },
      input: { borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 8, color: c.foreground, backgroundColor: c.surface0, minHeight: 40 },
    };
  }, [theme, layout.compact]);

  const data = query.data;
  const now = data?.now ?? Date.now();
  const items = [...(data?.items ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const pending = items.filter((i) => i.status === "pending");
  const done = items.filter((i) => i.status !== "pending").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));

  const toggle = (item: ItemView) => {
    setOpen(open === item.id ? null : item.id);
    setError(null);
    if (open !== item.id && item.status === "pending" && item.readAt === null) read.mutate(item.id);
  };

  const renderItem = (item: ItemView) => {
    const icon = statusIcon(item.status, theme.colors);
    const expanded = open === item.id;
    const unread = item.status === "pending" && item.readAt === null;
    const where = [item.projectName, item.workspaceName].filter(Boolean).join(" › ");
    const text = draft[item.id] ?? "";
    return (
      <View key={item.id} style={s.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${icon.label}: ${item.question}`} onPress={() => toggle(item)} style={s.head}>
          <Text accessibilityLabel={icon.label} style={{ color: icon.color, fontSize: 16, width: 18, textAlign: "center" }}>{icon.glyph}</Text>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={expanded ? undefined : 2} style={[s.text, unread ? { fontWeight: "700" } : null]}>
              {item.kind === "approval" ? "Approval: " : ""}
              {item.question}
            </Text>
            <Text style={s.muted} numberOfLines={1}>
              {[item.agentTitle ?? "Untitled conversation", where, ago(now, item.createdAt)].filter(Boolean).join(" · ")}
            </Text>
          </View>
        </Pressable>
        {expanded ? (
          <View style={s.detail}>
            {item.context ? <Text style={s.text} selectable>{item.context}</Text> : null}
            <Text style={s.muted} selectable>
              Agent {item.agentId} · {item.blocking ? "Blocking" : "Non-blocking"}
              {item.expiresAt ? ` · expires ${new Date(item.expiresAt).toLocaleString()}${item.defaultOptionId || item.defaultText ? ` (default: ${item.defaultOptionId ?? item.defaultText})` : ""}` : ""}
            </Text>
            {item.status === "pending" ? (
              <>
                {item.options.length > 0 ? (
                  <View style={s.choices}>
                    {item.options.map((o) => (
                      <Pressable
                        key={o.id}
                        accessibilityRole="button"
                        accessibilityLabel={o.label}
                        disabled={answer.isPending}
                        onPress={() => answer.mutate({ itemId: item.id, optionId: o.id, text: text || undefined })}
                        style={[s.button, o.id === "approve" ? { borderColor: theme.colors.statusSuccess } : o.id === "deny" ? { borderColor: theme.colors.statusDanger } : null]}
                      >
                        <Text style={s.text}>{o.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                <TextInput
                  value={text}
                  onChangeText={(v: string) => setDraft({ ...draft, [item.id]: v })}
                  placeholder={item.allowFreeText ? (item.options.length ? "Or write an answer (also sent as a comment with a choice)" : "Write an answer") : "Optional comment"}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  multiline
                  style={s.input}
                />
                {item.allowFreeText ? (
                  <View style={s.choices}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Send answer"
                      disabled={answer.isPending || !text.trim()}
                      onPress={() => answer.mutate({ itemId: item.id, text })}
                      style={[s.button, { backgroundColor: theme.colors.accent }, !text.trim() ? { opacity: 0.5 } : null]}
                    >
                      <Text style={{ color: theme.colors.accentForeground, fontSize: 14 }}>Send</Text>
                    </Pressable>
                  </View>
                ) : null}
                {error && open === item.id ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
              </>
            ) : (
              <Text style={s.text} selectable>
                {icon.label}
                {item.answer ? `: ${item.answer.optionId ? (item.options.find((o) => o.id === item.answer!.optionId)?.label ?? item.answer.optionId) : item.answer.text}${item.answer.by === "default" ? " (default)" : item.answer.by === "assistant" ? " (by the Assistant on behalf of Louis)" : ""}` : ""}
                {item.comment ? ` — ${item.comment}` : ""}
                {item.answer || item.status === "expired" ? ` · agent ${item.delivery === "sent" ? "notified" : item.delivery === "undeliverable" ? "archived or gone, so it could not be told" : item.delivery === "failed" ? "could not be notified" : "not yet notified"}` : ""}
              </Text>
            )}
          </View>
        ) : null}
      </View>
    );
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "pending", label: `Pending${pending.length ? ` (${pending.length})` : ""}` },
    { id: "answered", label: "History" },
    { id: "audit", label: "Audit" },
  ];

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      <Text style={s.h}>Agents Inbox</Text>
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
      {tab === "pending" ? (
        <>
          {data && pending.length === 0 ? <Text style={s.muted}>Nothing waiting. Agents ask with inbox_ask.</Text> : null}
          {pending.map(renderItem)}
        </>
      ) : null}
      {tab === "answered" ? (
        <>
          {data && done.length === 0 ? <Text style={s.muted}>No answered questions yet.</Text> : null}
          {done.map(renderItem)}
        </>
      ) : null}
      {tab === "audit" ? (
        <>
          {data && data.events.length === 0 ? <Text style={s.muted}>No events yet.</Text> : null}
          {[...(data?.events ?? [])].reverse().map((e, i) => (
            <Text key={`${e.at}-${i}`} style={s.muted} selectable>
              {new Date(e.at).toLocaleString()} · {e.type} · {e.itemId} · {e.actor}
              {e.detail ? ` · ${e.detail}` : ""}
            </Text>
          ))}
        </>
      ) : null}
      <Text style={s.muted}>Edit scope, timings and message templates under Settings → Plugins → Agents Inbox.</Text>
    </ScrollView>
  );
}
