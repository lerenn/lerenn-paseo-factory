import type { HistoryEvent, Run } from "./store";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Infrastructure flakes worth naming in a retro: OOM kills, pods that never started, scheduling and image errors. */
export const FLAKE = /exit(?:ed)?(?: code)?[ :=]*137|OOMKilled|\bSIGKILL\b|pod[^.\n]{0,60}(?:time(?:d)? ?out|did not start|failed to start)|(?:time(?:d)? ?out|start timeout)[^.\n]{0,40}pod|ImagePullBackOff|ErrImagePull|FailedScheduling|worker gone after restart/i;

const ENDS = new Set(["verdict", "transition", "exhausted", "skipped", "dispatch_failed"]);

export const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
};

interface Span {
  stage: string;
  from: number;
  to: number;
}

/** Each entry into a stage until the next event that ends it (a verdict, an edge taken, exhaustion) or the end of the run. */
export function spans(run: Run, now: number): Span[] {
  const end = run.endedAt ?? now;
  const out: Span[] = [];
  run.history.forEach((h, i) => {
    if (h.event !== "enter" || !h.stage) return;
    const stop = run.history.slice(i + 1).find((x) => x.stage === h.stage && ENDS.has(x.event));
    out.push({ stage: h.stage, from: h.at, to: stop?.at ?? end });
  });
  return out;
}

export function flakesOf(run: Run): string[] {
  const out: string[] = [];
  const seen = (text: string | null | undefined, where: string) => {
    if (text && FLAKE.test(text)) out.push(`${where}: ${clip(FLAKE.exec(text)![0], 60)}`);
  };
  for (const h of run.history) {
    if (h.event === "flake_retry") out.push(`${h.stage}: flake retry (${clip(h.detail ?? "", 100)})`);
    else seen(h.detail, `${h.stage ?? "?"}/${h.event}`);
  }
  for (const [id, st] of Object.entries(run.stages)) seen(st.summary, `${id} summary`);
  seen(run.error, "run error");
  return [...new Set(out)];
}

const TROUBLE = new Set(["flake_retry", "turn_ended", "exhausted", "paused", "dispatch_failed", "resumed", "retried"]);

/** A run that went straight through: nothing retried, nobody judged, no loop. */
export function isTrivial(run: Run): boolean {
  if (run.status !== "done") return false;
  if (Object.keys(run.pm.judged).length > 0) return false;
  if (run.history.some((h) => TROUBLE.has(h.event))) return false;
  if (Object.values(run.stages).some((s) => s.runs > 1 || s.flakes > 0)) return false;
  return run.vars.dependency_bump === "true" || (run.endedAt ?? 0) - run.createdAt < 15 * 60_000;
}

export interface DigestOptions {
  now: number;
  spend: { costUsd: number; turns: number } | null;
  /** Lines the janitor wants in the retro (what it keeps and why, or would archive). */
  janitor: string[];
}

/** The facts of a run, computed without a model: this is what the retro agent reads. */
export function buildDigest(run: Run, o: DigestOptions): string {
  const end = run.endedAt ?? o.now;
  const all = spans(run, o.now);
  const kind = (stage: string) => run.def.stage.find((s) => s.id === stage)?.kind ?? "agent";
  const total = (pred: (stage: string) => boolean) => all.filter((s) => pred(s.stage)).reduce((n, s) => n + (s.to - s.from), 0);
  const human = total((s) => kind(s) === "gate");
  const agent = total((s) => kind(s) === "agent");
  const lines: string[] = [];
  lines.push(`Run ${run.id} · blueprint ${run.blueprint} · ${run.vars.ticket || run.vars.incident_id || ""} · ${run.status}${run.error ? ` (${clip(run.error, 200)})` : ""}`);
  lines.push(`Total ${fmtDuration(end - run.createdAt)}; agent stages ${fmtDuration(agent)}, human gates ${fmtDuration(human)}, other ${fmtDuration(Math.max(0, end - run.createdAt - agent - human))}${o.spend ? `; ${o.spend.turns} turns, $${o.spend.costUsd.toFixed(2)}` : ""}`);

  lines.push("", "Stages (entries / attempts of the last entry / flakes / verdict / time):");
  for (const [id, st] of Object.entries(run.stages)) {
    const t = total((s) => s === id);
    lines.push(`- ${id} [${kind(id)}] ${st.runs}× / ${st.attempts} / ${st.flakes} / ${st.verdict ?? st.status} / ${fmtDuration(t)}${st.extra ? ` (+${st.extra} granted)` : ""}`);
  }

  const gates = all.filter((s) => kind(s.stage) === "gate");
  if (gates.length) lines.push("", "Gate waits: " + gates.map((g) => `${g.stage} ${fmtDuration(g.to - g.from)}`).join(", "));
  const pm = Object.entries(run.pm.judged);
  if (pm.length) lines.push(`PM judgements: ${pm.map(([s, j]) => `${s} (${clip(j.decision, 80)})`).join("; ")}`);

  const rounds = new Map<string, number>();
  for (const h of run.history) {
    const v = h.event === "verdict" ? /^(needs_fix|fail|blocked|unable_to_verify)\b/.exec(h.detail ?? "")?.[1] : undefined;
    if (v && h.stage) rounds.set(`${h.stage} ${v}`, (rounds.get(`${h.stage} ${v}`) ?? 0) + 1);
  }
  if (rounds.size) lines.push("Review/QA rounds: " + [...rounds].map(([k, n]) => `${k} ×${n}`).join(", "));
  const retries = run.history.filter((h) => h.event === "turn_ended" || h.event === "flake_retry").length;
  if (retries) lines.push(`Retries: ${retries} (nudges after a turn without a verdict, flake retries)`);
  const flakes = flakesOf(run);
  if (flakes.length) lines.push("Flakes: " + flakes.slice(0, 8).join("; "));
  if (o.janitor.length) lines.push("", "Janitor:", ...o.janitor.map((l) => `- ${l}`));

  const h = run.history;
  const pick: HistoryEvent[] = h.length > 70 ? [...h.slice(0, 35), ...h.slice(-35)] : h;
  lines.push("", `Timeline (${h.length} events${h.length > 70 ? ", middle elided" : ""}):`);
  for (const e of pick) lines.push(`+${fmtDuration(e.at - run.createdAt)} ${e.stage ?? "-"} ${e.event}${e.detail ? ` ${clip(e.detail.replace(/\s+/g, " "), 110)}` : ""}`);
  return clip(lines.join("\n"), 12_000);
}

/** The three-line mail for a run that went straight through. */
export function trivialMail(run: Run, o: { now: number; janitor: string[] }): { subject: string; body: string } {
  const label = run.vars.ticket || run.vars.incident_id || run.blueprint;
  const took = fmtDuration((run.endedAt ?? o.now) - run.createdAt);
  const human = spans(run, o.now)
    .filter((s) => (run.def.stage.find((d) => d.id === s.stage)?.kind ?? "agent") === "gate")
    .reduce((n, s) => n + (s.to - s.from), 0);
  return {
    subject: `Factory retro ${run.id} · ${label}: done in ${took}, no retries`,
    body: [`Run ${run.id} (${run.blueprint} ${label}) went straight through in ${took}; ${fmtDuration(human)} of it waiting for people.`, "Nothing retried, nobody judged, no loop: no improvement to suggest.", ...o.janitor.map((l) => `Janitor: ${l}`)].join("\n"),
  };
}
