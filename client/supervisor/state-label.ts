export function supervisorStateLabel(state: string | undefined, hasIncarnations: boolean): string {
  if (!state) return "…";
  if (state === "waking") return "Waking…";
  if (state === "archived" || (state === "not-started" && hasIncarnations)) return "Archived (idle)";
  if (state === "running" || state === "idle") return "Running";
  return state === "not-started" ? "Not started" : state;
}
