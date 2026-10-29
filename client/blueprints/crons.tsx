import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listCronsRpc, pauseCronRpc, resumeCronRpc, runCronNowRpc, type CronScheduleView } from "../../shared/blueprints/crons";

const when = (now: number, at: number) => {
  const min = Math.round((at - now) / 60_000);
  const local = new Date(at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return min < 90 ? `${local} (in ${Math.max(0, min)} min)` : `${local} (in ${Math.round(min / 60)} h)`;
};

/** The Crons sub-tab of Blueprints: cron schedules, their next run, the run they follow, Pause/Resume and Run now. */
export function CronsTab({ theme, layout }: Pick<PluginScreenProps, "theme" | "layout">) {
  const list = useRpc(listCronsRpc);
  const pauseCall = useRpc(pauseCronRpc);
  const resumeCall = useRpc(resumeCronRpc);
  const runNowCall = useRpc(runCronNowRpc);
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["crons", "list"], queryFn: () => list({}), refetchInterval: 10_000 });
  const done = (r: { ok: boolean; message: string | null; runId?: string | null }) => {
    setMessage(r.ok ? (r.runId ? `Started ${r.runId}` : r.message) : r.message);
    void queryClient.invalidateQueries({ queryKey: ["crons"] });
    void queryClient.invalidateQueries({ queryKey: ["blueprints"] });
  };
  const toggle = useMutation({ mutationFn: (s: CronScheduleView) => (s.paused ? resumeCall({ id: s.id }) : pauseCall({ id: s.id })), onSuccess: done });
  const runNow = useMutation({ mutationFn: (id: string) => runNowCall({ id }), onSuccess: done });

  const s = useMemo(() => {
    const c = theme.colors;
    const pad = layout.compact ? 10 : 20;
    return {
      screen: { flex: 1, backgroundColor: c.surface0 },
      body: { padding: pad, gap: 8 },
      muted: { color: c.foregroundMuted, fontSize: 12 },
      text: { color: c.foreground, fontSize: 14 },
      card: { borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, padding: 10, gap: 4 },
      warn: { borderRadius: 8, borderWidth: 1, borderColor: c.statusWarning, backgroundColor: c.surface1, padding: 10, gap: 4 },
      line: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      button: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 },
    };
  }, [theme, layout.compact]);
  const c = theme.colors;
  const data = query.data;
  const now = data?.now ?? Date.now();

  const state = (x: CronScheduleView) =>
    !data?.enabled ? { text: "crons off", color: c.foregroundMuted } : !x.enabled ? { text: "disabled", color: c.foregroundMuted } : x.paused ? { text: "paused", color: c.statusWarning } : { text: "on", color: c.statusSuccess };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      <Text style={s.muted}>Schedules from crons/schedules.json of the git sources and the Blueprints setting crons.schedules. One run at a time per schedule.</Text>
      {data && !data.enabled ? (
        <View style={s.warn}>
          <Text style={s.text}>Crons are off: nothing starts on its own. Switch on the Blueprints setting crons.enabled (Run now works either way).</Text>
        </View>
      ) : null}
      {message ? <Text style={s.text}>{message}</Text> : null}
      {query.error ? <Text style={{ color: c.statusDanger }}>{(query.error as Error).message}</Text> : null}
      {data && data.schedules.length === 0 ? <Text style={s.muted}>No schedules.</Text> : null}
      {data?.schedules.map((x) => {
        const st = state(x);
        return (
          <View key={x.id} style={s.card}>
            <View style={s.line}>
              <Text style={[s.text, { fontWeight: "600" }]}>{x.id}</Text>
              <Text style={{ color: st.color, fontSize: 12 }}>{st.text}</Text>
              <Text style={s.muted}>
                {x.cron} ({x.timezone}) → {x.blueprint}
              </Text>
            </View>
            <Text style={s.muted}>Next run: {x.nextRunAt ? when(now, x.nextRunAt) : "none"}</Text>
            <Text style={s.muted}>Active run: {x.activeRun ? `${x.activeRun.id} (${x.activeRun.status})` : "none"}</Text>
            <Text style={s.muted}>
              Last run: {x.lastRunId ?? "none"}
              {x.lastResult ? ` · ${x.lastResult}` : ""} · failures in a row {x.consecutiveFailures}/{x.maxFailures}
            </Text>
            <Text style={s.muted}>Source: {x.source}</Text>
            <View style={s.line}>
              <Pressable style={s.button} disabled={toggle.isPending} onPress={() => toggle.mutate(x)}>
                <Text style={s.text}>{x.paused ? "Resume" : "Pause"}</Text>
              </Pressable>
              <Pressable style={s.button} disabled={runNow.isPending || !!x.activeRun} onPress={() => runNow.mutate(x.id)}>
                <Text style={[s.text, x.activeRun ? { color: c.foregroundMuted } : null]}>Run now</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
      {data?.errors.length ? (
        <View style={s.warn}>
          <Text style={s.text}>Left out</Text>
          {data.errors.map((e) => (
            <Text key={e} style={s.muted} selectable>
              {e}
            </Text>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
