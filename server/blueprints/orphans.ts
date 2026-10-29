// Workspaces a Factory run created or joined that no agent is in any more (a dispatch that failed after the workspace was made,
// a crash, an agent archived or deleted behind the Factory's back): archived at once (human rule 2026-10-28), whatever their
// title and whatever their worktree holds. A closed agent (a pod agent that finished its turn) is resumable, so it still holds its
// workspace: only archived or deleted agents free one. A workspace no run knows (coordinators, daemon ops, one-shots) is never taken.
// Known means: an agent of a run lives (lived) in it, the Factory recorded creating it (even when its agent never came: a dispatch
// refused by a role's limit), or its title is one the Factory gives a stage of a run it holds (workspaces leaked before the record).
// The last two wait a grace period after creation, so a worker still starting is not raced.
import { pathExcluded } from "../exclusions";
import { isTrusted } from "../trust";
import { workspaceTitle } from "../workspace-title";

export interface ListedWorkspace {
  id: string;
  title?: string | null;
  name?: string | null;
  projectId?: string | null;
  projectRootPath?: string | null;
  workspaceDirectory?: string | null;
  archivingAt?: string | null;
  statusEnteredAt?: string | null;
  activityAt?: string | null;
}

/** How long a workspace no agent was registered in is left alone after its creation. */
export const ORPHAN_GRACE_MS = 10 * 60_000;

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
    /** Workspaces the Factory recorded creating: id -> creation time (ms). */
    created?: Map<string, number>;
    /** Workspace titles the Factory gives the stages of the runs it holds. */
    titles?: Set<string>;
    now?: number;
    graceMs?: number;
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
    if (w.archivingAt) return false;
    if (!o.known.has(w.id)) {
      const now = o.now ?? Date.now();
      const grace = o.graceMs ?? ORPHAN_GRACE_MS;
      const created = o.created?.get(w.id);
      if (created !== undefined) {
        if (now - created < grace) return false;
      } else {
        const title = (w.title || w.name || "").trim();
        if (!title || !o.titles?.has(title)) return false;
        const seen = Date.parse(w.statusEnteredAt ?? w.activityAt ?? "");
        if (Number.isFinite(seen) && now - seen < grace) return false;
      }
    }
    return !pathExcluded(w.workspaceDirectory ?? w.projectRootPath);
  });
}

/** The workspace titles the Factory gives the agent stages (and the PM) of these runs: how a leaked workspace is recognised. Pure. */
export function factoryWorkspaceTitles(runs: { id: string; blueprint: string; vars: Record<string, string>; def?: { stage?: unknown[] } }[], pmRole?: string): Set<string> {
  const titles = new Set<string>();
  for (const run of runs) {
    const name = `${run.blueprint} ${run.id}`;
    const roles = new Set<string>(pmRole ? [pmRole] : []);
    for (const st of run.def?.stage ?? []) {
      const role = (st as { role?: unknown }).role;
      if (typeof role === "string" && role) roles.add(role);
    }
    for (const role of roles) titles.add(workspaceTitle(role, run.vars, name));
  }
  return titles;
}
