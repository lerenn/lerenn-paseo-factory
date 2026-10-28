// Workspaces in a project the Factory spawns workers in that no live agent is in (a dispatch that failed after the workspace was
// made, a crash, an agent closed or archived behind the Factory's back): archived at once (human rule 2026-10-28), whatever
// their title and whatever their worktree holds. The PM, the Assistant and any workspace with a live agent are never taken.
import { pathExcluded } from "../exclusions";

export interface ListedWorkspace {
  id: string;
  title?: string | null;
  name?: string | null;
  projectId?: string | null;
  projectRootPath?: string | null;
  workspaceDirectory?: string | null;
}

export interface ListedAgent {
  id?: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
  status?: string;
  labels?: Record<string, string>;
}

/** The workspaces to archive now. Pure. */
export function agentlessWorkspaces(
  workspaces: ListedWorkspace[],
  agents: ListedAgent[],
  o: {
    /** Projects (ids) and project roots (paths) the Factory spawns workers in. */
    projects: Set<string>;
    roots: Set<string>;
    /** The PMs' agent ids: their workspace is never touched, live or not. */
    pmAgentIds: Set<string>;
    /** Workspaces to leave alone (the run's shared workspace, a spawn in progress). */
    protect?: Set<string>;
  },
): ListedWorkspace[] {
  const live = new Set<string>();
  const keep = new Set<string>(o.protect ?? []);
  for (const a of agents) {
    if (!a.workspaceId) continue;
    if ((a.id && o.pmAgentIds.has(a.id)) || a.labels?.["paseo.assistant"]) keep.add(a.workspaceId);
    if (!a.archivedAt && a.status !== "closed") live.add(a.workspaceId);
  }
  return workspaces.filter((w) => {
    if (live.has(w.id) || keep.has(w.id)) return false;
    if (!(w.projectId && o.projects.has(w.projectId)) && !(w.projectRootPath && o.roots.has(w.projectRootPath))) return false;
    return !pathExcluded(w.workspaceDirectory ?? w.projectRootPath);
  });
}
