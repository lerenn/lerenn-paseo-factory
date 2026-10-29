// Workspaces a Factory run created or joined that no agent is in any more (a dispatch that failed after the workspace was made,
// a crash, an agent archived or deleted behind the Factory's back): archived at once (human rule 2026-10-28), whatever their
// title and whatever their worktree holds. A closed agent (a pod agent that finished its turn) is resumable, so it still holds its
// workspace: only archived or deleted agents free one. A workspace no run knows (coordinators, daemon ops, one-shots) is never taken.
import { pathExcluded } from "../exclusions";
import { isTrusted } from "../trust";

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
    /** Ids of the workspaces a Factory run created or joined: the only ones that may be taken. */
    known: Set<string>;
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
    if ((a.id && o.pmAgentIds.has(a.id)) || isTrusted(a.labels)) keep.add(a.workspaceId);
    if (!a.archivedAt) live.add(a.workspaceId);
  }
  return workspaces.filter((w) => {
    if (live.has(w.id) || keep.has(w.id)) return false;
    if (!o.known.has(w.id)) return false;
    return !pathExcluded(w.workspaceDirectory ?? w.projectRootPath);
  });
}
