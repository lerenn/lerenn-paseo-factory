import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { usageLimitAuditRpc, usageLimitLiftRpc, usageLimitStatusRpc, type UsageLimitStatus } from "../../shared/blueprints/usage-limit";

const clock = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const until = (now: number, t: number | null) => (t ? `${clock(t)} (in ${Math.max(0, Math.round((t - now) / 60_000))} min)` : "on the next probe");

/** One line for the banner and the tab: what is held and until when. */
export function quotaHeadline(s: UsageLimitStatus): string {
  if (s.state === "paused") return `PAUSED: provider usage limit (${s.provider ?? "provider"}) · resumes ~${until(s.now, s.resumeAt)} · ${s.runs.length} run${s.runs.length === 1 ? "" : "s"} held`;
  if (s.state === "run_holds") return `${s.runs.length} run${s.runs.length === 1 ? "" : "s"} paused: quota · next resume ~${until(s.now, s.resumeAt)}`;
  return "No usage-limit hold";
}

function useLift() {
  const lift = useRpc(usageLimitLiftRpc);
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => lift({ by: "user" }),
    onSuccess: (r) => {
      setMessage(r.message);
      void queryClient.invalidateQueries({ queryKey: ["usage-limit"] });
      void queryClient.invalidateQueries({ queryKey: ["blueprints"] });
    },
  });
  return { mutation, message };
}

/** Shown above every Factory tab while something is held for a usage limit. */
export function UsageLimitBanner({ theme, onOpen }: { theme: PluginScreenProps["theme"]; onOpen(): void }) {
  const status = useRpc(usageLimitStatusRpc);
  const query = useQuery({ queryKey: ["usage-limit", "status"], queryFn: () => status({}), refetchInterval: 15_000, retry: false });
  const { mutation, message } = useLift();
  const [confirming, setConfirming] = useState(false);
  const s = query.data;
  const c = theme.colors;
  if (!s || s.state === "clear") return null;
  const button = { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 };
  return (
    <View style={{ borderBottomWidth: 1, borderColor: c.statusWarning, backgroundColor: c.surface1, padding: 10, gap: 4 }}>
      <Text style={{ color: c.statusWarning, fontWeight: "700" }}>! {quotaHeadline(s)}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }} selectable numberOfLines={2}>
        rule: {s.rule ?? "?"} · {s.evidence ?? ""}
      </Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Pressable style={button} onPress={onOpen}>
          <Text style={{ color: c.foreground, fontSize: 13 }}>View audit</Text>
        </Pressable>
        <Pressable style={button} disabled={mutation.isPending} onPress={() => (confirming ? (setConfirming(false), mutation.mutate()) : setConfirming(true))}>
          <Text style={{ color: c.foreground, fontSize: 13 }}>{confirming ? `Resume ${s.runs.length} run(s) now, staggered? Confirm` : "Lift pause"}</Text>
        </Pressable>
        {message ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{message}</Text> : null}
      </View>
    </View>
  );
}

/** The Quota sub-tab of Blueprints: the hold, the held runs and the audit log, with Lift pause. */
export function QuotaTab({ theme, layout }: Pick<PluginScreenProps, "theme" | "layout">) {
  const status = useRpc(usageLimitStatusRpc);
  const audit = useRpc(usageLimitAuditRpc);
  const q = useQuery({ queryKey: ["usage-limit", "status"], queryFn: () => status({}), refetchInterval: 10_000 });
  const log = useQuery({ queryKey: ["usage-limit", "audit"], queryFn: () => audit({ limit: 100 }), refetchInterval: 15_000 });
  const { mutation, message } = useLift();
  const [confirming, setConfirming] = useState(false);
  const st = useMemo(() => {
    const c = theme.colors;
    const pad = layout.compact ? 10 : 20;
    return {
      screen: { flex: 1, backgroundColor: c.surface0 },
      body: { padding: pad, gap: 8 },
      muted: { color: c.foregroundMuted, fontSize: 12 },
      text: { color: c.foreground, fontSize: 14 },
      card: { borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, padding: 10, gap: 4 },
      warn: { borderRadius: 8, borderWidth: 1, borderColor: c.statusWarning, backgroundColor: c.surface1, padding: 10, gap: 4 },
      button: { alignSelf: "flex-start" as const, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 },
    };
  }, [theme, layout.compact]);
  const s = q.data;
  const c = theme.colors;
  return (
    <ScrollView style={st.screen} contentContainerStyle={st.body}>
      <Text style={st.muted}>
        A worker whose turn fails on an explicit provider usage limit holds its run (paused: quota) without using an attempt. A second independent match, or a probe, holds the whole Factory until the reset time; runs resume in staggered batches.
      </Text>
      {s && !s.enabled ? (
        <View style={st.warn}>
          <Text style={st.text}>Off: usage limits are ordinary failed turns. Switch on the Blueprints setting usageLimit.enabled.</Text>
        </View>
      ) : null}
      {q.error ? <Text style={{ color: c.statusDanger }}>{(q.error as Error).message}</Text> : null}
      {s ? (
        <View style={s.state === "clear" ? st.card : st.warn}>
          <Text style={[st.text, { fontWeight: "600" }]}>{quotaHeadline(s)}</Text>
          {s.state !== "clear" ? (
            <>
              <Text style={st.muted}>Since {clock(s.since)}{s.confirmedBy ? ` · confirmed by ${s.confirmedBy}` : ""}</Text>
              <Text style={st.muted} selectable>
                Rule {s.rule ?? "?"}: {s.evidence ?? ""}
              </Text>
              <Pressable style={st.button} disabled={mutation.isPending} onPress={() => (confirming ? (setConfirming(false), mutation.mutate()) : setConfirming(true))}>
                <Text style={st.text}>{confirming ? `Resume ${s.runs.length} run(s) now, staggered? Confirm` : "Lift pause"}</Text>
              </Pressable>
            </>
          ) : null}
          {message ? <Text style={st.muted}>{message}</Text> : null}
          <Text style={st.muted}>Notify: {s.notify.join(", ") || "nobody"}{s.resuming.length ? ` · still to resume: ${s.resuming.join(", ")}` : ""}</Text>
        </View>
      ) : null}
      {s?.runs.length ? (
        <View style={st.card}>
          <Text style={[st.text, { fontWeight: "600" }]}>Held runs</Text>
          {s.runs.map((r) => (
            <Text key={r.runId} style={st.muted} selectable>
              {r.runId} · {r.blueprint} · {r.stage ?? "?"} · worker {r.agentId ?? "?"} · held {clock(r.heldAt)} · resume {clock(r.resumeAt)} · {r.source}
              {r.rule ? ` (${r.rule})` : ""}
            </Text>
          ))}
        </View>
      ) : null}
      <View style={st.card}>
        <Text style={[st.text, { fontWeight: "600" }]}>Audit log (newest first)</Text>
        {log.data?.entries.length ? null : <Text style={st.muted}>Nothing yet.</Text>}
        {log.data?.entries.map((e, i) => (
          <Text key={`${e.at}-${i}`} style={st.muted} selectable>
            {clock(e.at)} · {e.event} · by {e.by}
            {e.runId ? ` · ${e.runId}` : ""}
            {e.agentId ? ` · ${e.agentId}` : ""}
            {e.provider ? ` · ${e.provider}` : ""}
            {e.rule ? ` · ${e.rule}` : ""}
            {e.resetAt ? ` · reset ${clock(e.resetAt)}` : ""}
            {e.runs?.length ? ` · runs: ${e.runs.length}` : ""}
            {e.note ? ` · ${e.note}` : ""}
            {e.evidence ? ` · "${e.evidence}"` : ""}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}
