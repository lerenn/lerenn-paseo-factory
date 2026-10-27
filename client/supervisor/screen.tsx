import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { agentChatComponent } from "./agent-chat";
import { supervisorStartRpc, supervisorStatusRpc } from "../../shared/supervisor/rpc";

const ago = (now: number, at: number) => {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

export function SupervisorScreen({ theme, layout, navigation }: Pick<PluginScreenProps, "theme" | "layout" | "navigation">) {
  const c = theme.colors;
  const queryClient = useQueryClient();
  const callStatus = useRpc(supervisorStatusRpc);
  const callStart = useRpc(supervisorStartRpc);
  const [message, setMessage] = useState<string | null>(null);

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

  const card = { padding: 12, gap: 4, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 } as const;
  const muted = { color: c.foregroundMuted, fontSize: 12 } as const;
  const body = { color: c.foreground, fontSize: 13 } as const;
  const button = { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 } as const;
  const now = Date.now();
  const running = s?.state === "running" || s?.state === "idle";
  const AgentChat = agentChatComponent();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 10 : 16, gap: 10 }}>
      <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "600" }}>Supervisor</Text>
      {message ? <Text style={{ color: c.statusDanger }}>{message}</Text> : null}
      <View style={card}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Text style={[body, { fontWeight: "700" }]}>{s ? s.state : "…"}</Text>
          {s?.agentId ? <Text style={muted} selectable>agent {s.agentId}</Text> : null}
          {s?.startedAt ? <Text style={muted}>started {ago(now, s.startedAt)}</Text> : null}
          {s?.agentId && navigation ? (
            <Pressable style={button} onPress={() => navigation.openAgent({ agentId: s.agentId! })}>
              <Text style={body}>Open agent</Text>
            </Pressable>
          ) : null}
          <Pressable style={button} onPress={() => start.mutate(running)}>
            <Text style={body}>{running ? "Restart" : "Start"}</Text>
          </Pressable>
        </View>
        {s?.error ? <Text style={{ color: c.statusDanger, fontSize: 13 }} selectable>{s.error}</Text> : null}
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

      <View style={card}>
        <Text style={[body, { fontWeight: "700" }]}>Chat</Text>
        {!s?.agentId ? <Text style={muted}>The Supervisor is not running.</Text> : null}
        {s?.agentId && !AgentChat ? <Text style={muted}>This app cannot embed the conversation; use Open agent.</Text> : null}
        {s?.agentId && AgentChat ? (
          <View style={{ height: layout.compact ? 520 : 680, borderRadius: 8, overflow: "hidden" }}>
            <AgentChat key={s.agentId} agentId={s.agentId} />
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}
