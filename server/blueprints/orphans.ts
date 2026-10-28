// Workspaces the Factory created whose agent never started or is gone (a dispatch that failed after the workspace
// was made, a crash): no run knows them, so the orphan sweep finds them by their Factory title ("<Role>: <subject>").
// One must be seen without a live agent on two sweeps in a row, so a spawn in progress is never taken for one.
import { roleDisplayName } from "../workspace-title";

export interface ListedWorkspace {
  id: string;
  title?: string | null;
  name?: string | null;
}

/** The agentless Factory workspaces, and which to archive now (already agentless on the previous sweep). Pure. */
export function agentlessWorkspaces(
  workspaces: ListedWorkspace[],
  liveAgentWorkspaces: Set<string>,
  roles: string[],
  previous: Set<string>,
): { seen: Set<string>; archive: ListedWorkspace[] } {
  const names = [...new Set(roles.map(roleDisplayName))];
  const factoryTitle = (t: string) => names.some((n) => t === n || t.startsWith(`${n}: `));
  const seen = new Set<string>();
  const archive: ListedWorkspace[] = [];
  for (const w of workspaces) {
    const title = (w.title || w.name || "").trim();
    if (!title || !factoryTitle(title) || liveAgentWorkspaces.has(w.id)) continue;
    seen.add(w.id);
    if (previous.has(w.id)) archive.push(w);
  }
  return { seen, archive };
}
