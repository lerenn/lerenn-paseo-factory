import type { Run } from "./blueprints/store";

export type ActivityType = "run" | "stage" | "gate" | "escalation" | "lease" | "merge" | "deploy" | "inbox" | "extension";

export interface ActivityItem {
  at: number;
  type: ActivityType;
  title: string;
  detail: string | null;
  blueprint: string | null;
  role: string | null;
  /** Where to look: the module tab and the id inside it. */
  link: { tab: string; id: string } | null;
}

export interface ExtensionEvent {
  at: number;
  extension: string;
  /** "merge", "deploy" or any label; unknown types show as "extension". */
  type: string;
  title: string;
  detail?: string | null;
  link?: { tab: string; id: string } | null;
}

const RUN_EVENTS: Record<string, { type: ActivityType; label: string }> = {
  started: { type: "run", label: "started" },
  done: { type: "run", label: "finished" },
  failed: { type: "run", label: "failed" },
  aborted: { type: "run", label: "aborted" },
  enter: { type: "stage", label: "entered" },
  gate_opened: { type: "gate", label: "gate opened" },
  gate_answered: { type: "gate", label: "gate answered" },
  approval_reused: { type: "gate", label: "approval reused" },
  exhausted: { type: "escalation", label: "exhausted" },
  pm_grant: { type: "escalation", label: "PM granted attempts" },
  pm_rescope: { type: "escalation", label: "PM re-scoped" },
  stalled: { type: "escalation", label: "stalled" },
  head_moved: { type: "gate", label: "gate withdrawn, head moved" },
  merged: { type: "merge", label: "PRs merged" },
};

/** Normalise what happened across the Factory into one list, newest first. */
export function buildActivity(input: {
  runs: readonly Run[];
  inbox: readonly { at: number; itemId: string; type: string; actor: string; detail: string | null }[];
  leases: readonly { at: number; lease: string; type: string; actor: string; detail: string | null }[];
  extensions: readonly ExtensionEvent[];
  limit?: number;
}): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const run of input.runs) {
    const label = run.vars.ticket || run.vars.incident_id || run.id;
    for (const h of run.history) {
      const known = RUN_EVENTS[h.event];
      if (!known) continue;
      const role = h.stage ? ((run.def.stage.find((s) => s.id === h.stage) as { role?: string } | undefined)?.role ?? null) : null;
      out.push({
        at: h.at,
        type: known.type,
        title: `${run.blueprint} ${label}: ${known.label}${h.stage && h.event !== "started" ? ` · ${h.stage}` : ""}`,
        detail: h.detail,
        blueprint: run.blueprint,
        role,
        link: { tab: "blueprints", id: run.id },
      });
    }
  }
  const askedLabel: Record<string, string> = { asked: "asked", answered: "answered", expired: "expired", withdrawn: "withdrawn" };
  for (const e of input.inbox) {
    if (!askedLabel[e.type]) continue;
    out.push({ at: e.at, type: "inbox", title: `Inbox item ${e.itemId} ${askedLabel[e.type]}`, detail: e.detail ? `${e.actor}: ${e.detail}` : e.actor, blueprint: null, role: null, link: { tab: "inbox", id: e.itemId } });
  }
  const leaseLabel: Record<string, string> = { acquired: "taken", granted: "granted from the queue", taken_over: "taken over", released: "released", force_released: "force-released", expired: "expired" };
  for (const e of input.leases) {
    if (!leaseLabel[e.type]) continue;
    out.push({ at: e.at, type: "lease", title: `Lease ${e.lease} ${leaseLabel[e.type]}`, detail: e.detail ? `${e.actor}: ${e.detail}` : e.actor, blueprint: null, role: null, link: { tab: "leases", id: e.lease } });
  }
  for (const e of input.extensions) {
    const type: ActivityType = e.type === "merge" || e.type === "deploy" ? e.type : "extension";
    out.push({ at: e.at, type, title: e.title, detail: e.detail ?? null, blueprint: null, role: null, link: e.link ?? { tab: `ext:${e.extension}`, id: "" } });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, input.limit ?? 300);
}
