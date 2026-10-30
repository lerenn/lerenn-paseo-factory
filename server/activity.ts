import { runLabel } from "../shared/blueprints/label";
import type { Run } from "./blueprints/store";

/** The Factory's own kinds of events. An extension event carries its own type (see `extensionType`). */
export type BuiltinActivityType = "run" | "stage" | "gate" | "escalation" | "lease" | "merge" | "inbox" | "extension";
export const BUILTIN_ACTIVITY_TYPES: readonly BuiltinActivityType[] = ["run", "stage", "gate", "escalation", "lease", "merge", "inbox", "extension"];
export type ActivityType = BuiltinActivityType | (string & {});
export type ActivityTone = "success" | "warning" | "danger";
const TONES: readonly string[] = ["success", "warning", "danger"];

export interface ActivityItem {
  at: number;
  type: ActivityType;
  /** Colour of the type badge; null: muted. */
  tone: ActivityTone | null;
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
  /** The extension's own label (for example "deploy"): lowercase letters, digits, - and _, at most 24; anything else shows as "extension". */
  type: string;
  /** Colour of the type badge ("success", "warning", "danger"); absent: muted ("merge" defaults to success). */
  tone?: string | null;
  title: string;
  detail?: string | null;
  link?: { tab: string; id: string } | null;
}

/** The type an extension event shows under: its own label, unless it is malformed or one of the Factory's own kinds other than merge. */
export function extensionType(type: string): ActivityType {
  return /^[a-z][a-z0-9_-]{0,23}$/.test(type) && (type === "merge" || !BUILTIN_ACTIVITY_TYPES.includes(type as BuiltinActivityType)) ? type : "extension";
}

const builtinTone = (type: ActivityType): ActivityTone | null => (type === "escalation" ? "warning" : type === "merge" ? "success" : null);

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
    const label = runLabel(run);
    for (const h of run.history) {
      const known = RUN_EVENTS[h.event];
      if (!known) continue;
      const role = h.stage ? ((run.def.stage.find((s) => s.id === h.stage) as { role?: string } | undefined)?.role ?? null) : null;
      out.push({
        at: h.at,
        type: known.type,
        tone: builtinTone(known.type),
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
    out.push({ at: e.at, type: "inbox", tone: null, title: `Inbox item ${e.itemId} ${askedLabel[e.type]}`, detail: e.detail ? `${e.actor}: ${e.detail}` : e.actor, blueprint: null, role: null, link: { tab: "inbox", id: e.itemId } });
  }
  const leaseLabel: Record<string, string> = { acquired: "taken", granted: "granted from the queue", taken_over: "taken over", released: "released", force_released: "force-released", expired: "expired" };
  for (const e of input.leases) {
    if (!leaseLabel[e.type]) continue;
    out.push({ at: e.at, type: "lease", tone: null, title: `Lease ${e.lease} ${leaseLabel[e.type]}`, detail: e.detail ? `${e.actor}: ${e.detail}` : e.actor, blueprint: null, role: null, link: { tab: "leases", id: e.lease } });
  }
  for (const e of input.extensions) {
    const type = extensionType(e.type);
    const tone = e.tone && TONES.includes(e.tone) ? (e.tone as ActivityTone) : builtinTone(type);
    out.push({ at: e.at, type, tone, title: e.title, detail: e.detail ?? null, blueprint: null, role: null, link: e.link ?? { tab: `ext:${e.extension}`, id: "" } });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, input.limit ?? 300);
}
