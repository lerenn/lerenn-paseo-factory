import type { PrSnapshot, RunSnapshot } from "../host";
import type { AgentStage, GateStage } from "../../shared/blueprints/blueprint";
import type { CachedPrFacts } from "./pr-facts-cache";
import type { Run } from "./store";

/** Every PR URL a run refers to: its stages' `data.pr_urls` and the heads its gates hold. */
export function prUrlsOf(run: Run): string[] {
  const out = new Set<string>();
  for (const st of Object.values(run.stages)) {
    const urls = st.data?.pr_urls;
    if (Array.isArray(urls)) for (const u of urls) if (typeof u === "string") out.add(u);
    for (const u of Object.keys(st.gate?.heads ?? {})) out.add(u);
  }
  return [...out];
}

/**
 * What another plugin sees of a run (`GET /blueprints/runs`): read-only, built from the store and the PR facts the Factory
 * already has in memory; it never calls GitHub.
 */
export function runSnapshot(run: Run, facts: (url: string) => CachedPrFacts | undefined): RunSnapshot {
  const id = run.stage;
  const st = id ? run.stages[id] : undefined;
  const def = id ? run.def.stage.find((s) => s.id === id) : undefined;
  const kind = def?.kind ?? "agent";
  let gate: RunSnapshot["gate"] = null;
  if (id && st?.gate && st.status === "waiting") {
    const g = def as GateStage | undefined;
    const passive = !!st.gate.passive;
    gate = {
      stage: id,
      itemId: st.gate.itemId || null,
      kind: passive ? "merge" : !g?.free_text && !g?.options ? "approval" : "question",
      openedAt: st.gate.openedAt ?? null,
      passive,
    };
  }
  const prs: Record<string, PrSnapshot> = {};
  for (const url of prUrlsOf(run)) {
    const f = facts(url);
    if (!f) continue;
    const { url: _url, ...rest } = f;
    prs[url] = rest;
  }
  return {
    id: run.id,
    blueprint: run.blueprint,
    status: run.status,
    parent: run.parent,
    vars: run.vars,
    updatedAt: run.updatedAt,
    endedAt: run.endedAt,
    stages: Object.fromEntries(Object.entries(run.stages).map(([sid, s]) => [sid, { status: s.status, verdict: s.verdict, summary: s.summary, data: s.data }])),
    events: [...new Set(run.history.map((h) => h.event))],
    stage: id,
    waitingFor: run.waitingFor,
    pmPending: run.pm.pending,
    suspended: run.suspended ? { reason: run.suspended.reason, since: run.suspended.at, by: run.suspended.by } : null,
    gate,
    escalations: Object.keys(run.escalations ?? {}),
    agentId: kind === "agent" ? (st?.agentId ?? null) : null,
    role: kind === "agent" && def ? (def as AgentStage).role : null,
    prs,
  };
}
