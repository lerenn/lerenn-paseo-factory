import type { RunView } from "./run";

type Event = RunView["history"][number];

/** One entry into a stage, from `enter` to the next `enter`/end of the run. */
export interface Segment {
  stage: string;
  /** Entry number of the stage (1 for the first time through). */
  entry: number;
  startedAt: number;
  endedAt: number | null;
  /** Time a worker was expected to be working. */
  workingMs: number;
  /** Time spent waiting for a person, the PM or a child run. */
  waitingMs: number;
  /** Dispatches to a worker (the first one plus nudges and retries). */
  attempts: number;
  /** Failed turns retried for free. */
  retries: number;
  gateOpenedAt: number | null;
  gateClosedAt: number | null;
  /** Exhaustion, PM judgement and escalation events. */
  escalations: string[];
  verdict: string | null;
}


/**
 * Turn a run's saved history into per-stage segments: time per stage, attempts and retries, gate open and close
 * times, waiting vs working, and escalations. `now` closes a segment that is still open.
 */
export function buildTimeline(history: readonly Event[], now: number, endedAt: number | null = null): Segment[] {
  const out: Segment[] = [];
  const entries = new Map<string, number>();
  let cur: Segment | null = null;
  const close = (at: number) => {
    if (!cur) return;
    cur.endedAt = at;
    cur = null;
  };
  const span = (seg: Segment, from: number, to: number, waiting: boolean) => {
    const ms = Math.max(0, to - from);
    if (waiting) seg.waitingMs += ms;
    else seg.workingMs += ms;
  };
  let mark = 0; // start of the current working/waiting stretch
  let waiting = false;
  for (const h of history) {
    if (h.event === "enter" && h.stage) {
      close(h.at);
      const n = (entries.get(h.stage) ?? 0) + 1;
      entries.set(h.stage, n);
      cur = { stage: h.stage, entry: n, startedAt: h.at, endedAt: null, workingMs: 0, waitingMs: 0, attempts: 0, retries: 0, gateOpenedAt: null, gateClosedAt: null, escalations: [], verdict: null };
      out.push(cur);
      mark = h.at;
      waiting = false;
      continue;
    }
    if (!cur) continue;
    const seg: Segment = cur;
    if (h.event === "spawned" || h.event === "sent") seg.attempts += 1;
    else if (h.event === "flake_retry") seg.retries += 1;
    else if (h.event === "gate_opened" || h.event === "child_started") {
      span(seg, mark, h.at, waiting);
      mark = h.at;
      waiting = true;
      if (h.event === "gate_opened") seg.gateOpenedAt = h.at;
    } else if (h.event === "gate_answered" || h.event === "head_moved" || h.event === "merged" || h.event === "approval_reused") {
      span(seg, mark, h.at, waiting);
      mark = h.at;
      waiting = false;
      seg.gateClosedAt = h.at;
      if (h.event === "head_moved") seg.escalations.push("head moved");
    } else if (h.event === "exhausted") {
      span(seg, mark, h.at, waiting);
      mark = h.at;
      waiting = true; // waits for the PM or a person
      seg.escalations.push(`exhausted${h.detail ? `: ${h.detail}` : ""}`);
    } else if (h.event === "pm_grant" || h.event === "pm_rescope") {
      span(seg, mark, h.at, waiting);
      mark = h.at;
      waiting = false;
      seg.escalations.push(`${h.event === "pm_grant" ? "PM granted" : "PM re-scoped"}${h.detail ? ` ${h.detail}` : ""}`);
    } else if (h.event === "stalled") seg.escalations.push("stalled");
    else if (h.event === "verdict") {
      seg.verdict = (h.detail ?? "").split(":")[0] || null;
      span(seg, mark, h.at, waiting);
      mark = h.at;
      waiting = false;
    } else if (["done", "failed", "aborted"].includes(h.event)) {
      span(seg, mark, h.at, waiting);
      mark = h.at;
      close(h.at);
    }
  }
  const open = cur as Segment | null;
  if (open) {
    const end = endedAt ?? now;
    span(open, mark, end, waiting);
    open.endedAt = endedAt;
  }
  return out;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
}
