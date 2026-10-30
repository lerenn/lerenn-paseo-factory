import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { answerRpc, listItemsRpc, readRpc } from "../../shared/inbox/rpc";
import type { ItemStatus, ItemView } from "../../shared/inbox/item";
import { CollapsibleRow } from "../collapsible-row";
import { INBOX_FIELDS, ModuleSettings } from "../module-settings";
import { SubTabs } from "../subtabs";
import { inboxSettings } from "../../shared/inbox/settings";

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

/** `focus`: an item to show opened (an extension tab's `open({tab: "inbox", itemId})`), on the sub-tab that holds it. */
export function InboxScreen({ theme, layout, focus }: PluginScreenProps & { focus?: string }) {
  const list = useRpc(listItemsRpc);
  const answerCall = useRpc(answerRpc);
  const readCall = useRpc(readRpc);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({ queryKey: ["inbox", "items"], queryFn: () => list({ audit: true }), refetchInterval: 10_000 });
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

  const renderItem = (item: ItemView) => {
    const icon = statusIcon(item.status, theme.colors);
    const unread = item.status === "pending" && item.readAt === null;
    const where = [item.projectName, item.workspaceName].filter(Boolean).join(" › ");
    const text = draft[item.id] ?? "";
    return (
      <CollapsibleRow
        key={item.id}
        theme={theme}
        pill={{ text: item.status === "pending" ? item.kind : icon.label.toLowerCase(), color: icon.color }}
        title={`${item.kind === "approval" && item.status !== "pending" ? "Approval: " : ""}${item.question}`}
        bold={unread}
        initiallyOpen={item.id === focus}
        parts={[item.agentTitle ?? "Untitled conversation", where || null, ago(now, item.createdAt)]}
        onOpen={() => {
          setError(null);
          if (item.status === "pending" && item.readAt === null) read.mutate(item.id);
        }}
      >
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
                        style={[
                          s.button,
                          o.recommended ? { borderColor: theme.colors.accent, borderWidth: 2 } : o.id === "approve" ? { borderColor: theme.colors.statusSuccess } : o.id === "deny" ? { borderColor: theme.colors.statusDanger } : null,
                        ]}
                      >
                        <Text style={s.text}>
                          {o.label}
                          {o.recommended ? " (recommended)" : ""}
                        </Text>
                        {o.description ? <Text style={s.muted}>{o.description}</Text> : null}
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                {item.kind === "info" ? null : <TextInput
                  value={text}
                  onChangeText={(v: string) => setDraft({ ...draft, [item.id]: v })}
                  placeholder={item.options.length ? "Other… (write an answer; with a choice above it is sent as a comment)" : "Other… (write an answer)"}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  multiline
                  style={s.input}
                />}
                {item.allowFreeText ? (
                  <View style={s.choices}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Send as Other"
                      disabled={answer.isPending || !text.trim()}
                      onPress={() => answer.mutate({ itemId: item.id, text })}
                      style={[s.button, { backgroundColor: theme.colors.accent }, !text.trim() ? { opacity: 0.5 } : null]}
                    >
                      <Text style={{ color: theme.colors.accentForeground, fontSize: 14 }}>{item.options.length ? "Send as Other" : "Send"}</Text>
                    </Pressable>
                  </View>
                ) : null}
                {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
              </>
            ) : (
              <Text style={s.text} selectable>
                {icon.label}
                {item.answer ? `: ${item.answer.optionId ? (item.options.find((o) => o.id === item.answer!.optionId)?.label ?? item.answer.optionId) : item.answer.text}${item.answer.by === "default" ? " (default)" : item.answer.by === "assistant" ? " (by the Assistant on behalf of the user)" : item.answer.by === "pm" ? " (by the run's PM)" : ""}` : ""}
                {item.comment ? ` — ${item.comment}` : ""}
                {item.kind !== "info" && (item.answer || item.status === "expired") ? ` · agent ${item.delivery === "sent" ? "notified" : item.delivery === "undeliverable" ? "archived or gone, so it could not be told" : item.delivery === "failed" ? "could not be notified" : "not yet notified"}` : ""}
              </Text>
            )}
          </View>
      </CollapsibleRow>
    );
  };

  const page = (children: React.ReactNode) => (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      {query.isError ? <Text style={s.muted}>Could not load: {String(query.error)}</Text> : null}
      {data?.endpoint.error ? <Text style={s.text}>{data.endpoint.error}</Text> : null}
      {data?.settingsError ? <Text style={s.text}>Invalid settings: {data.settingsError}</Text> : null}
      {children}
    </ScrollView>
  );

  return (
    <View style={s.screen}>
      <Text style={[s.h, { paddingHorizontal: layout.compact ? 10 : 20, paddingTop: 12 }]}>Inbox</Text>
      <SubTabs
        key={focus ? (data ? "focus" : "loading") : "plain"}
        theme={theme}
        initial={focus && done.some((i) => i.id === focus) ? "history" : undefined}
        tabs={[
          {
            key: "pending",
            label: "Pending",
            badge: pending.length,
            render: () =>
              page(
                <>
                  {data && pending.length === 0 ? <Text style={s.muted}>Nothing waiting. Agents ask with inbox_ask.</Text> : null}
                  {pending.map(renderItem)}
                </>,
              ),
          },
          {
            key: "history",
            label: "History",
            render: () =>
              page(
                <>
                  {data && done.length === 0 ? <Text style={s.muted}>No answered questions yet.</Text> : null}
                  {done.map(renderItem)}
                  {data && data.events.length > 0 ? (
                    <>
                      <Text style={[s.text, { fontWeight: "700", marginTop: 8 }]}>Audit log</Text>
                      {[...data.events].reverse().slice(0, 200).map((e, i) => (
                        <Text key={`${e.at}-${i}`} style={s.muted} selectable>
                          {new Date(e.at).toLocaleString()} · {e.type} · {e.itemId} · {e.actor}
                          {e.detail ? ` · ${e.detail}` : ""}
                        </Text>
                      ))}
                    </>
                  ) : null}
                </>,
              ),
          },
          { key: "settings", label: "Settings", render: () => <ModuleSettings theme={theme} definition={inboxSettings} fields={INBOX_FIELDS} title="Inbox settings" /> },
        ]}
      />
    </View>
  );
}
