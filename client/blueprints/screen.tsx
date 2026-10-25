import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { abortRunRpc, listRunsRpc, retryRunRpc, startRunRpc } from "../../shared/blueprints/rpc";
import type { RunView, StageView } from "../../shared/blueprints/run";

type Colors = PluginScreenProps["theme"]["colors"];

function statusColor(status: string, c: Colors): string {
  switch (status) {
    case "done":
      return c.statusSuccess;
    case "failed":
    case "exhausted":
    case "aborted":
      return c.statusDanger;
    case "waiting":
    case "paused":
      return c.statusWarning;
    case "running":
    case "entering":
      return c.accent;
    default:
      return c.foregroundMuted;
  }
}

function ago(now: number, at: number): string {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  return min < 1 ? "just now" : min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

/** Runs that need a person or the PM: waiting on a PM judgement, failed, or paused. */
export function needsAttention(run: RunView): boolean {
  return run.pmPending !== null || run.status === "failed" || run.status === "paused";
}

export function BlueprintsScreen({ theme, layout }: PluginScreenProps) {
  const list = useRpc(listRunsRpc);
  const startCall = useRpc(startRunRpc);
  const abortCall = useRpc(abortRunRpc);
  const resumeCall = useRpc(retryRunRpc);
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<string | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [at, setAt] = useState("");
  const [resumeStage, setResumeStage] = useState<Record<string, string>>({});
  const [resumeExtra, setResumeExtra] = useState<Record<string, string>>({});

  const query = useQuery({ queryKey: ["blueprints", "list", showFinished], queryFn: () => list({ includeFinished: showFinished }), refetchInterval: 5_000 });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["blueprints"] });
  const start = useMutation({
    mutationFn: () => startCall({ blueprint: picked!, vars: Object.fromEntries(Object.entries(vars).filter(([, v]) => v.trim() !== "")), at: at.trim() || undefined }),
    onSuccess: (r) => {
      setMessage(r.ok ? `Started ${r.runId}` : r.message);
      refresh();
    },
  });
  const abort = useMutation({
    mutationFn: (runId: string) => abortCall({ runId }),
    onSuccess: (r) => {
      setMessage(r.ok ? null : r.message);
      refresh();
    },
  });
  const resume = useMutation({
    mutationFn: (run: RunView) =>
      resumeCall({ runId: run.id, stage: resumeStage[run.id]?.trim() || run.pmPending?.stage || undefined, extraAttempts: Number(resumeExtra[run.id] ?? "1") || 0 }),
    onSuccess: (r) => {
      setMessage(r.ok ? null : r.message);
      refresh();
    },
  });

  const s = useMemo(() => {
    const c = theme.colors;
    const pad = layout.compact ? 10 : 20;
    return {
      screen: { flex: 1, backgroundColor: c.surface0 },
      body: { padding: pad, gap: 8 },
      h: { color: c.foreground, fontSize: layout.compact ? 17 : 20, fontWeight: "600" as const },
      muted: { color: c.foregroundMuted, fontSize: 12 },
      text: { color: c.foreground, fontSize: 14 },
      card: { borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, padding: 10, gap: 6 },
      warn: { borderRadius: 8, borderWidth: 1, borderColor: c.statusWarning, backgroundColor: c.surface1, padding: 10, gap: 4 },
      line: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      button: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 },
      input: { borderWidth: 1, borderColor: c.border, borderRadius: 6, paddingVertical: 4, paddingHorizontal: 8, color: c.foreground, minWidth: 140, fontSize: 13 },
    };
  }, [theme, layout.compact]);
  const c = theme.colors;
  const data = query.data;
  const now = data?.now ?? Date.now();
  const blueprint = data?.blueprints.find((b) => b.name === picked) ?? null;
  const missing = blueprint?.vars.filter((v) => v.required && !(vars[v.name] ?? "").trim()) ?? [];

  const pill = (text: string, color: string) => (
    <View style={{ paddingVertical: 1, paddingHorizontal: 8, borderRadius: 10, borderWidth: 1, borderColor: color }}>
      <Text style={{ color, fontSize: 11, fontWeight: "700" }}>{text}</Text>
    </View>
  );

  const stageChip = (st: StageView, current: boolean) => {
    const color = statusColor(st.status, c);
    const tries = st.maxAttempts !== null ? ` ${st.attempts}/${st.maxAttempts}` : "";
    const runs = st.maxRuns !== null && st.runs > 1 ? ` · run ${st.runs}/${st.maxRuns}` : "";
    return (
      <View key={st.id} style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 6, borderWidth: current ? 2 : 1, borderColor: color }}>
        <Text style={{ color, fontSize: 11 }}>
          {st.id}
          {tries}
          {runs}
        </Text>
      </View>
    );
  };

  const renderRun = (run: RunView) => {
    const active = run.status === "running" || run.status === "waiting";
    const canResume = run.status === "failed" || run.status === "paused" || run.pmPending !== null;
    const varEntries = Object.entries(run.vars).filter(([, v]) => v !== "").sort(([a], [b]) => (a === "ticket" ? -1 : b === "ticket" ? 1 : 0));
    const open = expanded[run.id];
    return (
      <View key={run.id} style={s.card}>
        <View style={s.line}>
          <Text style={[s.text, { fontWeight: "700" }]}>{run.blueprint}</Text>
          {pill(run.status, statusColor(run.status, c))}
          <Text style={s.muted} selectable>{run.id}</Text>
          <Text style={s.muted}>started {ago(now, run.createdAt)} by {run.requestedBy}</Text>
        </View>
        <View style={s.line}>{run.stages.map((st) => stageChip(st, st.id === run.stage))}</View>
        {run.stage ? <Text style={s.text}>Stage: {run.stage}</Text> : null}
        {run.waitingFor ? <Text style={s.muted}>Waiting for {run.waitingFor}</Text> : null}
        {run.pmPending ? <Text style={[s.text, { color: c.statusWarning }]}>PM judgement pending on {run.pmPending.stage}: {run.pmPending.reason}</Text> : null}
        {run.error ? <Text style={[s.text, { color: c.statusDanger }]} selectable>{run.error}</Text> : null}
        {run.parent ? <Text style={s.muted}>Child of {run.parent.runId} (stage {run.parent.stageId})</Text> : null}
        {varEntries.length > 0 ? (
          <Text style={s.muted} selectable>{varEntries.map(([k, v]) => `${k}=${v.length > 60 ? `${v.slice(0, 59)}…` : v}`).join(" · ")}</Text>
        ) : null}
        <Pressable onPress={() => setExpanded((e) => ({ ...e, [run.id]: !e[run.id] }))}>
          <Text style={s.muted}>{open ? "▾" : "▸"} History ({run.history.length})</Text>
        </Pressable>
        {(open ? run.history.slice(-30) : run.history.slice(-5)).map((h, i) => (
          <Text key={`${h.at}-${i}`} style={s.muted} selectable>
            {ago(now, h.at)} · {h.event}
            {h.stage ? ` · ${h.stage}` : ""}
            {h.detail ? ` · ${h.detail}` : ""}
          </Text>
        ))}
        {canResume ? (
          <View style={s.line}>
            <TextInput
              style={s.input}
              placeholder={`stage (${run.pmPending?.stage ?? run.stage ?? "?"})`}
              placeholderTextColor={c.foregroundMuted}
              value={resumeStage[run.id] ?? ""}
              onChangeText={(v) => setResumeStage((m) => ({ ...m, [run.id]: v }))}
            />
            <TextInput
              style={[s.input, { minWidth: 60 }]}
              placeholder="extra"
              placeholderTextColor={c.foregroundMuted}
              keyboardType="numeric"
              value={resumeExtra[run.id] ?? "1"}
              onChangeText={(v) => setResumeExtra((m) => ({ ...m, [run.id]: v }))}
            />
            <Pressable style={s.button} onPress={() => resume.mutate(run)}>
              <Text style={s.text}>Resume</Text>
            </Pressable>
          </View>
        ) : null}
        {active ? (
          <View style={s.line}>
            <Pressable style={s.button} onPress={() => abort.mutate(run.id)}>
              <Text style={[s.text, { color: c.statusDanger }]}>Abort</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  const runs = data?.runs ?? [];
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      <Text style={s.h}>Blueprints</Text>
      {query.isError ? <Text style={s.muted}>Could not load: {String(query.error)}</Text> : null}
      {message ? <Text style={s.text}>{message}</Text> : null}
      {data && data.errors.length > 0 ? (
        <View style={s.warn}>
          <Text style={[s.text, { fontWeight: "700" }]}>Blueprint files with errors</Text>
          {data.errors.map((e) => (
            <Text key={e.file} style={s.muted} selectable>{e.file}: {e.message}</Text>
          ))}
        </View>
      ) : null}

      <View style={s.card}>
        <Text style={[s.text, { fontWeight: "700" }]}>Start a run</Text>
        {data && data.blueprints.length === 0 ? <Text style={s.muted}>No blueprints yet. They load from the blueprints/ folder of the Roles git source.</Text> : null}
        <View style={s.line}>
          {data?.blueprints.map((b) => (
            <Pressable
              key={b.name}
              style={[s.button, picked === b.name ? { borderColor: c.accent } : null]}
              onPress={() => {
                setPicked(b.name);
                setVars({});
                setAt("");
              }}
            >
              <Text style={s.text}>{b.name}</Text>
            </Pressable>
          ))}
        </View>
        {blueprint ? (
          <>
            {blueprint.description ? <Text style={s.muted}>{blueprint.description}</Text> : null}
            {blueprint.vars.map((v) => (
              <View key={v.name} style={s.line}>
                <Text style={s.text}>
                  {v.name}
                  {v.required ? " *" : ""}
                </Text>
                <TextInput
                  style={[s.input, { flexGrow: 1 }]}
                  placeholder={v.description}
                  placeholderTextColor={c.foregroundMuted}
                  value={vars[v.name] ?? ""}
                  onChangeText={(t) => setVars((m) => ({ ...m, [v.name]: t }))}
                />
              </View>
            ))}
            <View style={s.line}>
              <Text style={s.text}>at</Text>
              <TextInput style={s.input} placeholder={`first stage (${blueprint.stages.join(", ")})`} placeholderTextColor={c.foregroundMuted} value={at} onChangeText={setAt} />
            </View>
            <View style={s.line}>
              <Pressable style={[s.button, missing.length ? { opacity: 0.5 } : null]} disabled={missing.length > 0} onPress={() => start.mutate()}>
                <Text style={s.text}>Start</Text>
              </Pressable>
              {missing.length ? <Text style={s.muted}>Missing: {missing.map((m) => m.name).join(", ")}</Text> : null}
            </View>
          </>
        ) : null}
      </View>

      <View style={s.line}>
        <Text style={[s.text, { fontWeight: "700" }]}>Runs</Text>
        <Pressable style={s.button} onPress={() => setShowFinished((v) => !v)}>
          <Text style={s.muted}>{showFinished ? "Hide finished" : "Show finished"}</Text>
        </Pressable>
      </View>
      {data && runs.length === 0 ? <Text style={s.muted}>No runs yet.</Text> : null}
      {runs.map(renderRun)}
    </ScrollView>
  );
}
