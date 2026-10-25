import type { GitStatus } from "../../shared/roles/rpc";

/** One line for the collapsed panel: how many sources, which, and whether the last sync worked. */
export function sourcesSummary(statuses: GitStatus[]): string {
  if (statuses.length === 0) return "No git source configured.";
  const failed = statuses.filter((g) => g.error).length;
  const names = statuses.map((g) => g.label).join(", ");
  return `${statuses.length} source${statuses.length === 1 ? "" : "s"}: ${names}${failed ? ` · ${failed} failing to sync` : ""}`;
}
