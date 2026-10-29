import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ExternalLink, SettingsCard, SettingsInput, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { TranscriptPeek } from "../transcript-peek";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { abortRunRpc, listRunsRpc, retryRunRpc, runDiffRpc, startRunRpc, suspendRunsRpc } from "../../shared/blueprints/rpc";
import type { RunView, StageView } from "../../shared/blueprints/run";
import { buildTimeline, formatDuration } from "../../shared/blueprints/timeline";
import { blueprintsSettings } from "../../shared/blueprints/settings";
import type { BlueprintInfo, StageDetail } from "../../shared/blueprints/rpc";
import { SubTabs } from "../subtabs";
import { BlueprintGraph } from "./graph";

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
    case "suspended":
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
export { needsAttention } from "./attention";
import { needsAttention } from "./attention";

/** PRs of a run with their diff summary; fetched only once the card is open. */
function RunPullRequests({ runId, s }: { runId: string; s: Record<string, any> }) {
  const call = useRpc(runDiffRpc);
  const q = useQuery({ queryKey: ["blueprints", "diff", runId], queryFn: () => call({ runId }), staleTime: 30_000 });
  const label = (url: string) => url.replace(/^https?:\/\/[^/]+\//, "");
  if (!q.data || q.data.prs.length === 0) return null;
  return (
    <View style={{ gap: 2 }}>
      <Text style={s.muted}>Pull requests</Text>
      {q.data.prs.map((pr) => (
        <View key={pr.url} style={s.line}>
          <Text style={s.text} selectable>{label(pr.url)}</Text>
          <Text style={s.muted}>{pr.error ? pr.error : `${pr.files} files, +${pr.additions} −${pr.deletions}`}</Text>
          <ExternalLink href={pr.filesUrl}>View full diff</ExternalLink>
        </View>
      ))}
    </View>
  );
}

export function BlueprintsScreen({ theme, layout, navigation }: PluginScreenProps) {
  const list = useRpc(listRunsRpc);
  const startCall = useRpc(startRunRpc);
  const abortCall = useRpc(abortRunRpc);
  const resumeCall = useRpc(retryRunRpc);
  const suspendCall = useRpc(suspendRunsRpc);
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [tabKey, setTabKey] = useState(0);
  const [openTemplate, setOpenTemplate] = useState<Record<string, boolean>>({});
  const [showSource, setShowSource] = useState<Record<string, boolean>>({});
  const settings = useSettings(blueprintsSettings);
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

  const suspend = useMutation({
    mutationFn: (o: { runId?: string; all?: boolean; resume?: boolean }) => suspendCall(o),
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
    const active = run.status === "running" || run.status === "waiting" || run.status === "paused" || run.status === "suspended";
    const canResume = run.status === "failed" || run.status === "paused" || run.pmPending !== null;
    const varEntries = Object.entries(run.vars).filter(([, v]) => v !== "").sort(([a], [b]) => (a === "ticket" ? -1 : b === "ticket" ? 1 : 0));
    const open = expanded[run.id];
    const label = run.vars.ticket || run.vars.incident_id || run.id;
    const header = (
      <Pressable onPress={() => setExpanded((e) => ({ ...e, [run.id]: !e[run.id] }))} style={s.line}>
        <Text style={s.muted}>{open ? "▾" : "▸"}</Text>
        {pill(run.status, statusColor(run.status, c))}
        <Text style={[s.text, { fontWeight: "700", flexShrink: 1 }]} numberOfLines={1}>{run.blueprint} · {label}</Text>
        {run.stage ? <Text style={s.muted} numberOfLines={1}>{run.stage}</Text> : null}
        <Text style={s.muted}>{ago(now, run.createdAt)}</Text>
      </Pressable>
    );
    if (!open) return <View key={run.id} style={[s.card, { paddingVertical: 6 }]}>{header}</View>;
    return (
      <View key={run.id} style={s.card}>
        {header}
        <Text style={s.muted} selectable>{run.id} · started by {run.requestedBy}</Text>
        <View style={s.line}>{run.stages.map((st) => stageChip(st, st.id === run.stage))}</View>
        {run.stage ? <Text style={s.text}>Stage: {run.stage}</Text> : null}
        {run.waitingFor ? <Text style={s.muted}>Waiting for {run.waitingFor}</Text> : null}
        {run.suspended ? (
          <>
            <Text style={[s.text, { color: c.statusWarning }]} selectable>Suspended {ago(now, run.suspended.since)} by {run.suspended.by}: {run.suspended.reason}</Text>
            {run.suspended.pods.map((p) => <Text key={p} style={s.muted} selectable>{p}</Text>)}
          </>
        ) : null}
        {run.pmPending ? <Text style={[s.text, { color: c.statusWarning }]}>PM judgement pending on {run.pmPending.stage}: {run.pmPending.reason}</Text> : null}
        {run.error ? <Text style={[s.text, { color: c.statusDanger }]} selectable>{run.error}</Text> : null}
        {run.parent ? <Text style={s.muted}>Child of {run.parent.runId} (stage {run.parent.stageId})</Text> : null}
        {varEntries.length > 0 ? (
          <Text style={s.muted} selectable>{varEntries.map(([k, v]) => `${k}=${v.length > 60 ? `${v.slice(0, 59)}…` : v}`).join(" · ")}</Text>
        ) : null}
        <RunPullRequests runId={run.id} s={s} />
        {(() => {
          const agentId = run.stages.find((st) => st.id === run.stage)?.agentId ?? null;
          return agentId ? <TranscriptPeek agentId={agentId} theme={theme} navigation={navigation} /> : null;
        })()}
        <View style={s.line}>
          <Pressable onPress={() => setExpanded((e) => ({ ...e, [`tl:${run.id}`]: !e[`tl:${run.id}`] }))}>
            <Text style={s.muted}>{expanded[`tl:${run.id}`] ? "▾" : "▸"} Timeline</Text>
          </Pressable>
          <Pressable onPress={() => setExpanded((e) => ({ ...e, [`gr:${run.id}`]: !e[`gr:${run.id}`] }))}>
            <Text style={s.muted}>{expanded[`gr:${run.id}`] ? "▾" : "▸"} Flows</Text>
          </Pressable>
        </View>
        {expanded[`gr:${run.id}`] ? (
          (() => {
            const bp = data?.blueprints.find((b) => b.name === run.blueprint);
            return bp ? <BlueprintGraph blueprint={bp} run={run} runs={data?.runs ?? []} blueprints={data?.blueprints ?? []} theme={theme} navigation={navigation} /> : <Text style={s.muted}>The blueprint {run.blueprint} is no longer loaded.</Text>;
          })()
        ) : null}
        {expanded[`tl:${run.id}`]
          ? buildTimeline(run.history, now, run.endedAt).map((seg, i) => (
              <View key={`${seg.stage}-${seg.entry}-${i}`} style={{ gap: 1, paddingLeft: 8 }}>
                <Text style={s.text} selectable>
                  {seg.stage}
                  {seg.entry > 1 ? ` (entry ${seg.entry})` : ""} · {formatDuration((seg.endedAt ?? now) - seg.startedAt)}
                  {seg.verdict ? ` → ${seg.verdict}` : seg.endedAt === null ? " · running" : ""}
                </Text>
                <Text style={s.muted} selectable>
                  working {formatDuration(seg.workingMs)} · waiting {formatDuration(seg.waitingMs)}{seg.assistantMs ? ` · answered by the Assistant in ${formatDuration(seg.assistantMs)}` : ""} · {seg.attempts} dispatch{seg.attempts === 1 ? "" : "es"}
                  {seg.retries ? ` · ${seg.retries} retr${seg.retries === 1 ? "y" : "ies"}` : ""}
                  {seg.gateOpenedAt !== null ? ` · gate opened ${ago(now, seg.gateOpenedAt)}${seg.gateClosedAt !== null ? `, closed ${ago(now, seg.gateClosedAt)}` : ", still open"}` : ""}
                </Text>
                {seg.escalations.map((e, j) => (
                  <Text key={j} style={[s.muted, { color: c.statusWarning }]} selectable>
                    ⚠ {e}
                  </Text>
                ))}
              </View>
            ))
          : null}
        <Text style={s.muted}>History ({run.history.length})</Text>
        {run.history.slice(-30).map((h, i) => (
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
            {run.status === "suspended" ? (
              <Pressable style={s.button} onPress={() => suspend.mutate({ runId: run.id, resume: true })}>
                <Text style={s.text}>Resume</Text>
              </Pressable>
            ) : (
              <Pressable style={s.button} onPress={() => suspend.mutate({ runId: run.id })}>
                <Text style={s.text}>Suspend</Text>
              </Pressable>
            )}
            <Pressable style={s.button} onPress={() => abort.mutate(run.id)}>
              <Text style={[s.text, { color: c.statusDanger }]}>Abort</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  const runs = [...(data?.runs ?? [])].sort((x, y) => Number(y.endedAt === null) - Number(x.endedAt === null) || y.createdAt - x.createdAt);
  const errors = data?.errors ?? [];

  const startFrom = (b: BlueprintInfo) => {
    setPicked(b.name);
    setVars({});
    setAt("");
    setStartOpen(true);
    setTabKey((k) => k + 1);
  };

  const errorsBox = errors.length > 0 ? (
    <View style={s.warn}>
      <Text style={[s.text, { fontWeight: "700" }]}>Blueprint files with errors</Text>
      {errors.map((e) => (
        <Text key={e.file} style={s.muted} selectable>{e.file}: {e.message}</Text>
      ))}
    </View>
  ) : null;

  const startForm = (
    <View style={s.card}>
      <Text style={[s.text, { fontWeight: "700" }]}>Start a run</Text>
      {data && data.blueprints.length === 0 ? <Text style={s.muted}>No blueprints yet. They load from the blueprints/ folder of the Factory git source (Settings tab).</Text> : null}
      <View style={s.line}>
        {data?.blueprints.map((b) => (
          <Pressable key={b.name} style={[s.button, picked === b.name ? { borderColor: c.accent } : null]} onPress={() => { setPicked(b.name); setVars({}); setAt(""); }}>
            <Text style={s.text}>{b.name}</Text>
          </Pressable>
        ))}
      </View>
      {blueprint ? (
        <>
          {blueprint.description ? <Text style={s.muted}>{blueprint.description}</Text> : null}
          {blueprint.vars.map((v) => (
            <View key={v.name} style={s.line}>
              <Text style={s.text}>{v.name}{v.required ? " *" : ""}</Text>
              <TextInput style={[s.input, { flexGrow: 1 }]} placeholder={v.description} placeholderTextColor={c.foregroundMuted} value={vars[v.name] ?? ""} onChangeText={(t) => setVars((m) => ({ ...m, [v.name]: t }))} />
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
  );

  const runsTab = () => (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      {query.isError ? <Text style={s.muted}>Could not load: {String(query.error)}</Text> : null}
      {message ? <Text style={s.text}>{message}</Text> : null}
      {data?.factorySuspended ? (
        <View style={s.warn}>
          <Text style={[s.text, { fontWeight: "700" }]}>The Factory is suspended</Text>
          <Text style={s.muted} selectable>{data.factorySuspended.reason} · {ago(now, data.factorySuspended.since)} by {data.factorySuspended.by}. No run starts and nothing is respawned until it is resumed.</Text>
          <View style={s.line}>
            <Pressable style={s.button} onPress={() => suspend.mutate({ all: true, resume: true })}>
              <Text style={s.text}>Resume all</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      <View style={s.line}>
        <Pressable style={s.button} onPress={() => setStartOpen((v) => !v)}>
          <Text style={s.text}>{startOpen ? "Close" : "Start a run"}</Text>
        </Pressable>
        <Pressable style={s.button} onPress={() => setShowFinished((v) => !v)}>
          <Text style={s.muted}>{showFinished ? "Hide finished" : "Show finished"}</Text>
        </Pressable>
        {data?.factorySuspended ? null : (
          <Pressable style={s.button} onPress={() => suspend.mutate({ all: true })}>
            <Text style={s.muted}>Suspend all</Text>
          </Pressable>
        )}
        {errors.length > 0 ? <Text style={[s.muted, { color: c.statusWarning }]}>{errors.length} blueprint file{errors.length > 1 ? "s" : ""} with errors (see Templates)</Text> : null}
      </View>
      {startOpen ? startForm : null}
      {data && runs.length === 0 ? <Text style={s.muted}>No runs yet.</Text> : null}
      {runs.map(renderRun)}
    </ScrollView>
  );

  const edge = (d: StageDetail, key: string) => `${key} → ${d.on[key]}`;
  const renderStage = (d: StageDetail, index: number) => {
    const caps = [d.maxAttempts !== null ? `max_attempts ${d.maxAttempts}` : null, d.maxRuns !== null ? `max_runs ${d.maxRuns}` : null, d.flakeRetries ? `flake_retries ${d.flakeRetries}` : null].filter(Boolean).join(" · ");
    const keys = Object.keys(d.on);
    return (
      <View key={d.id} style={{ borderLeftWidth: 2, borderLeftColor: c.border, paddingLeft: 8, gap: 2 }}>
        <Text style={s.text}>
          {index + 1}. <Text style={{ fontWeight: "700" }}>{d.id}</Text> · {d.kind}
          {d.role ? ` · role ${d.role}` : ""}
          {d.agent && d.agent !== "new" ? ` · ${d.agent} (same worker)` : ""}
          {d.tool ? ` · tool ${d.tool}` : ""}
          {d.childBlueprint ? ` · child run of ${d.childBlueprint}` : ""}
        </Text>
        {d.title ? <Text style={s.muted}>{d.title}</Text> : null}
        {d.skipIf ? <Text style={s.muted}>skipped if {d.skipIf}</Text> : null}
        {caps ? <Text style={s.muted}>{caps}</Text> : null}
        {d.gate ? (
          <Text style={s.muted}>
            gate (Inbox): {d.gate.question}
            {d.gate.pr ? ` · tied to PR heads (${d.gate.pr})` : ""}
            {d.gate.criteria ? " · criteria hashed, identical approval reused" : ""}
            {d.gate.freeText ? " · free text" : ""}
            {d.gate.storeAs ? ` · answer stored in ${d.gate.storeAs}` : ""}
            {d.gate.noteTo ? ` · answer added to notes of ${d.gate.noteTo}` : ""}
          </Text>
        ) : null}
        {d.facts ? <Text style={s.muted}>PR facts shown to the worker; data.pr_urls checked</Text> : null}
        {Object.entries(d.verify).map(([v, facts]) => <Text key={v} style={s.muted}>verdict {v} needs: {facts.join(", ")}</Text>)}
        {d.usesLease ? <Text style={s.muted}>uses a lease (see its role)</Text> : null}
        {keys.length > 0 ? <Text style={s.text} selectable>{keys.map((k) => edge(d, k)).join("   ")}</Text> : null}
      </View>
    );
  };

  const templatesTab = () => (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      {errorsBox}
      {data && data.blueprints.length === 0 ? <Text style={s.muted}>No blueprints loaded. They come from the blueprints/ folder of the Factory git source (Settings tab).</Text> : null}
      {data?.blueprints.map((b) => {
        const open = openTemplate[b.name];
        const required = b.vars.filter((v) => v.required).map((v) => v.name);
        const header = (
          <Pressable onPress={() => setOpenTemplate((m) => ({ ...m, [b.name]: !m[b.name] }))} style={s.line}>
            <Text style={s.muted}>{open ? "▾" : "▸"}</Text>
            <Text style={[s.text, { fontWeight: "700" }]}>{b.name}</Text>
            <Text style={[s.muted, { flexShrink: 1 }]} numberOfLines={1}>{b.description}</Text>
            <Text style={s.muted} numberOfLines={1}>{b.source}</Text>
            <Text style={s.muted}>{b.stages.length} stages</Text>
            {required.length ? <Text style={s.muted} numberOfLines={1}>needs {required.join(", ")}</Text> : null}
          </Pressable>
        );
        if (!open) return <View key={b.name} style={[s.card, { paddingVertical: 6 }]}>{header}</View>;
        return (
          <View key={b.name} style={s.card}>
            {header}
            {b.description ? <Text style={s.text}>{b.description}</Text> : null}
            <Text style={s.muted}>Source: {b.source} · pm_extra_max {b.pmExtraMax}{b.confirm.length ? ` · must be confirmed: ${b.confirm.join(", ")}` : ""}</Text>
            <Text style={s.muted}>Variables: {b.vars.map((v) => `${v.name}${v.required ? "*" : ""}`).join(", ") || "none"}</Text>
            <Pressable onPress={() => setShowSource((m) => ({ ...m, [`gr:${b.name}`]: !m[`gr:${b.name}`] }))}>
              <Text style={s.muted}>{showSource[`gr:${b.name}`] ? "▾" : "▸"} Flows</Text>
            </Pressable>
            {showSource[`gr:${b.name}`] ? <BlueprintGraph blueprint={b} run={null} runs={data?.runs ?? []} blueprints={data?.blueprints ?? []} theme={theme} navigation={navigation} /> : null}
            <View style={{ gap: 8 }}>{b.details.map(renderStage)}</View>
            <View style={s.line}>
              <Pressable style={s.button} onPress={() => startFrom(b)}>
                <Text style={s.text}>Start a run</Text>
              </Pressable>
              <Pressable style={s.button} onPress={() => setShowSource((m) => ({ ...m, [b.name]: !m[b.name] }))}>
                <Text style={s.muted}>{showSource[b.name] ? "Hide source" : "View source"}</Text>
              </Pressable>
            </View>
            {showSource[b.name] ? <Text style={[s.muted, { fontFamily: "monospace" }]} selectable>{b.text}</Text> : null}
          </View>
        );
      })}
    </ScrollView>
  );

  const settingsTab = () => (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      {settings.status === "ready" ? (
        <SettingsCard>
          <SettingsInput label="Working directory for workers" hint="Where new workers start when a stage names none. Required to run anything." initialValue={settings.values.defaultCwd ?? ""} onChangeText={(v) => void settings.save({ ...settings.values, defaultCwd: v.trim() || undefined }, settings.revision)} placeholder="/path/to/checkout" />
          <SettingsInput label="Worker provider" initialValue={settings.values.defaultProvider} onChangeText={(v) => v.trim() && void settings.save({ ...settings.values, defaultProvider: v.trim() }, settings.revision)} />
          <SettingsInput label="PM role" hint="Role of the PM agent the Factory spawns when a run has none to ask." initialValue={settings.values.pmRole} onChangeText={(v) => v.trim() && void settings.save({ ...settings.values, pmRole: v.trim() }, settings.revision)} />
          <SettingsInput label="Poll interval (seconds)" hint="How often PR gates are polled and idle workers checked." initialValue={String(settings.values.pollSeconds)} onChangeText={(v) => Number(v) >= 10 && void settings.save({ ...settings.values, pollSeconds: Math.round(Number(v)) }, settings.revision)} />
          <SettingsInput label="Idle grace (seconds)" hint="A worker idle this long without a verdict gets nudged." initialValue={String(settings.values.idleGraceSeconds)} onChangeText={(v) => Number(v) >= 10 && void settings.save({ ...settings.values, idleGraceSeconds: Math.round(Number(v)) }, settings.revision)} />
          <SettingsSwitch label="Archive workers when a run finishes" value={settings.values.archiveOnFinish} onValueChange={(on) => void settings.save({ ...settings.values, archiveOnFinish: on }, settings.revision)} />
          {settings.saveError ? <Text style={{ color: c.statusDanger }}>{settings.saveError}</Text> : null}
        </SettingsCard>
      ) : (
        <Text style={s.muted}>{settings.status === "loading" ? "Loading…" : `Settings: ${"error" in settings ? settings.error : ""}`}</Text>
      )}
    </ScrollView>
  );

  return (
    <View style={s.screen}>
      <Text style={[s.h, { padding: layout.compact ? 10 : 20, paddingBottom: 0 }]}>Blueprints</Text>
      <SubTabs
        key={tabKey}
        theme={theme}
        initial={tabKey > 0 ? "runs" : undefined}
        tabs={[
          { key: "runs", label: "Runs", badge: runs.filter((r) => r.endedAt === null).length, render: runsTab },
          { key: "templates", label: "Templates", badge: errors.length || undefined, render: templatesTab },
          { key: "settings", label: "Settings", render: settingsTab },
        ]}
      />
    </View>
  );
}
