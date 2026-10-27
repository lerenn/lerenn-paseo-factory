import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { agentChatComponent } from "./agent-chat";
import { supervisorStateLabel } from "./state-label";
import { supervisorSendRpc, supervisorStartRpc, supervisorStatusRpc } from "../../shared/supervisor/rpc";

const ago = (now: number, at: number) => {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

export function SupervisorScreen({ theme, layout, navigation }: Pick<PluginScreenProps, "theme" | "layout" | "navigation">) {
  const c = theme.colors;
  const queryClient = useQueryClient();
  const callStatus = useRpc(supervisorStatusRpc);
  const callStart = useRpc(supervisorStartRpc);
  const callSend = useRpc(supervisorSendRpc);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [showPrevious, setShowPrevious] = useState(false);

  const status = useQuery({ queryKey: ["supervisor", "status"], queryFn: () => callStatus({}), refetchInterval: 5_000 });
  const s = status.data?.status;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["supervisor"] });
  const start = useMutation({
    mutationFn: (restart: boolean) => callStart({ restart }),
    onSuccess: (r) => {
      setMessage(r.ok ? null : r.message);
      refresh();
    },
  });

  const send = useMutation({
    mutationFn: (text: string) => callSend({ text }),
    onSuccess: (r) => {
      setMessage(r.message);
      if (r.ok) setDraft("");
      refresh();
    },
  });

  const muted = { color: c.foregroundMuted, fontSize: 12 } as const;
  const body = { color: c.foreground, fontSize: 13 } as const;
  const button = { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 } as const;
  const now = Date.now();
  const running = s?.state === "running" || s?.state === "idle";
  const archived = s?.state === "archived" || (s?.state === "not-started" && !!s.incarnations.length);
  const waking = s?.state === "waking";
  const previous = (s?.incarnations ?? []).filter((i) => i.agentId !== s?.agentId).reverse();
  const AgentChat = agentChatComponent();

  const dot = waking ? c.statusWarning : running ? c.statusSuccess : c.foregroundMuted;

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0, padding: layout.compact ? 8 : 12, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
        <Text style={[body, { flex: 1 }]}>{supervisorStateLabel(s?.state, !!s?.incarnations.length)}</Text>
        <Pressable style={button} onPress={() => setMenuOpen(!menuOpen)} accessibilityLabel="Details">
          <Text style={body}>…</Text>
        </Pressable>
      </View>
      {message ? <Text style={{ color: c.statusDanger }}>{message}</Text> : null}
      <View style={{ flex: 1, gap: 8 }}>
        {!s?.agentId && waking ? <Text style={muted}>Waking up… your message is delivered once it is up.</Text> : null}
        {!s?.agentId ? (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Message to the Supervisor"
              placeholderTextColor={c.foregroundMuted}
              style={{ flex: 1, color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}
            />
            <Pressable style={button} onPress={() => draft.trim() && send.mutate(draft.trim())}>
              <Text style={body}>Send</Text>
            </Pressable>
          </View>
        ) : null}
        {s?.agentId && !AgentChat ? <Text style={muted}>This app cannot embed the conversation; use Open agent.</Text> : null}
        {s?.agentId && AgentChat ? (
          <View style={{ flex: 1 }}>
            <AgentChat key={s.agentId} agentId={s.agentId} />
          </View>
        ) : null}
      </View>


      {menuOpen ? (
        <ScrollView style={{ position: "absolute", top: layout.compact ? 44 : 52, right: layout.compact ? 8 : 12, width: 360, maxWidth: "95%", maxHeight: "80%", borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }} contentContainerStyle={{ padding: 12, gap: 14 }}>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Text style={[body, { fontWeight: "700" }]}>{!s ? "…" : waking ? "waking up…" : archived ? "Archived (idle)" : s.state}</Text>
          {s?.agentId ? <Text style={muted} selectable>agent {s.agentId}</Text> : null}
          {s?.startedAt ? <Text style={muted}>started {ago(now, s.startedAt)}</Text> : null}
          {s?.agentId && navigation ? (
            <Pressable style={button} onPress={() => navigation.openAgent({ agentId: s.agentId! })}>
              <Text style={body}>Open agent</Text>
            </Pressable>
          ) : null}
          <Pressable style={button} onPress={() => start.mutate(running)} disabled={waking}>
            <Text style={body}>{running ? "Restart" : archived ? "Wake now" : "Start"}</Text>
          </Pressable>
        </View>
        {s?.error ? <Text style={{ color: c.statusDanger, fontSize: 13 }} selectable>{s.error}</Text> : null}
        {running && s?.busy ? (
          <Text style={muted}>
            {s.busy.busy ? `Busy: ${s.busy.reasons.slice(0, 3).join(", ")}` : s.idleArchiveAt ? `Idle: archived ${ago(s.idleArchiveAt, now) === "just now" ? "any moment" : `in ${Math.max(1, Math.round((s.idleArchiveAt - now) / 60_000))}m`}` : "Idle"}
          </Text>
        ) : null}
        {s && s.queued > 0 ? <Text style={muted}>{s.queued} item{s.queued === 1 ? "" : "s"} waiting for the Supervisor to wake up…</Text> : null}
        {(s?.flags ?? []).slice(-5).map((f) => (
          <Text key={f.key} style={{ color: c.statusWarning, fontSize: 12 }} numberOfLines={2}>
            🚩 {f.text}
          </Text>
        ))}
        <Text style={muted}>Watching {s?.issues.length ?? 0} problem{s?.issues.length === 1 ? "" : "s"}{s?.lastDigestAt ? ` · last digest ${ago(now, s.lastDigestAt)}` : ""}</Text>
        {(s?.issues ?? []).slice(0, 8).map((i) => (
          <Text key={i.key} style={{ color: c.statusWarning, fontSize: 12 }} numberOfLines={2}>
            ⚠ {i.text}
          </Text>
        ))}
        {(s?.restarts ?? []).slice(-3).map((r) => (
          <Text key={`${r.extension}-${r.at}`} style={muted}>
            restarted extension {r.extension} {ago(now, r.at)}
          </Text>
        ))}
      </View>


      <View style={{ gap: 4 }}>
        <Pressable onPress={() => setShowPrevious(!showPrevious)}>
          <Text style={[body, { fontWeight: "700" }]}>Previous sessions ({previous.length}) {showPrevious ? "▾" : "▸"}</Text>
        </Pressable>
        {showPrevious
          ? previous.map((i) => (
              <View key={i.agentId} style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Text style={muted}>
                  #{i.n} {ago(now, i.startedAt)}
                  {i.endedAt ? ` · ended ${ago(now, i.endedAt)}${i.reason ? ` (${i.reason})` : ""}` : ""}
                </Text>
                {navigation ? (
                  <Pressable style={button} onPress={() => navigation.openAgent({ agentId: i.agentId })}>
                    <Text style={body}>Open</Text>
                  </Pressable>
                ) : null}
              </View>
            ))
          : null}
      </View>


      <View style={{ gap: 4 }}>
        <Text style={[body, { fontWeight: "700" }]}>Requests</Text>
        {(s?.requests ?? []).length === 0 ? <Text style={muted}>No request from other agents yet.</Text> : null}
        {(s?.requests ?? [])
          .slice()
          .reverse()
          .slice(0, 15)
          .map((r) => (
            <View key={r.id} style={{ gap: 2 }}>
              <Text style={muted}>
                {ago(now, r.at)} · {r.fromName} · {r.answer !== null ? "answered" : r.deliveredAt === null ? "queued" : "pending"}
              </Text>
              <Text style={body} numberOfLines={2}>{r.question}</Text>
              {r.answer !== null ? <Text style={muted} numberOfLines={3}>→ {r.answer}</Text> : null}
            </View>
          ))}
      </View>
        </ScrollView>
      ) : null}
    </View>
  );
}
