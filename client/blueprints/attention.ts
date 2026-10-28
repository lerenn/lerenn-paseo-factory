import type { RunView } from "../../shared/blueprints/run";

export function needsAttention(run: RunView): boolean {
  return run.pmPending !== null || run.status === "failed" || run.status === "paused";
}

/** For the sidebar badge: a run whose escalation is already an inbox item is counted once, through that item. */
export function needsAttentionBadge(run: RunView): boolean {
  return needsAttention(run) && (run.escalations ?? []).length === 0;
}
