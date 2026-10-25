import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { transcriptRpc } from "../shared/rpc";

/** Read-only "latest messages" of an agent, closed by default; polls only while open. */
export function TranscriptPeek({ agentId, theme, navigation }: { agentId: string; theme: PluginScreenProps["theme"]; navigation?: PluginScreenProps["navigation"] }) {
  const c = theme.colors;
  const [open, setOpen] = useState(false);
  const call = useRpc(transcriptRpc);
  const q = useQuery({ queryKey: ["factory", "transcript", agentId], queryFn: () => call({ agentId, limit: 8 }), enabled: open, refetchInterval: open ? 10_000 : false });
  const colorOf = (role: string) => (role === "error" ? c.statusDanger : role === "user" ? c.accent : role === "tool" ? c.foregroundMuted : c.foreground);
  return (
    <View style={{ gap: 2 }}>
      <Pressable onPress={() => setOpen((v) => !v)}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Latest messages {open ? "▾" : "▸"}</Text>
      </Pressable>
      {open ? (
        <View style={{ gap: 3, paddingLeft: 8 }}>
          {q.isLoading ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Loading…</Text> : null}
          {q.data && !q.data.ok ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>{q.data.error}</Text> : null}
          {q.data?.ok && q.data.messages.length === 0 ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>No messages.</Text> : null}
          {q.data?.messages.map((m, i) => (
            <Text key={i} selectable numberOfLines={6} style={{ color: colorOf(m.role), fontSize: 12 }}>
              {m.role}: {m.text}
            </Text>
          ))}
          {navigation?.openAgent ? (
            <Pressable onPress={() => navigation.openAgent({ agentId })}>
              <Text style={{ color: c.accent, fontSize: 12 }}>Open agent</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
