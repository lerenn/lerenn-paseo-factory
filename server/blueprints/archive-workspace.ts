import type { Probe } from "./worktree";

export interface ArchiveWorkspacePorts {
  /** The workspace (pod) the Factory created or joined for this agent; null when it is not a Factory agent or runs locally. */
  workspaceOf(agentId: string): string | null;
  /** Ids of the agents still alive (not archived, not closed) in the workspace, or null when they could not be listed. */
  liveAgentsIn(workspaceId: string): Promise<string[] | null>;
  worktree(workspaceId: string): Promise<Probe>;
  archiveWorkspace(workspaceId: string): Promise<void>;
  log(line: string): void;
}

/**
 * An agent the Factory spawned was archived (by the Factory, by itself or by a person): archive its workspace too, or the pod and its
 * volume leak against the quota. Only a workspace the Factory created or joined for it, with no other live agent left and a clean
 * worktree (nothing uncommitted or unpushed, same check as the janitor). Anything doubtful is kept.
 */
export async function archiveWorkspaceWithAgent(ports: ArchiveWorkspacePorts, agentId: string): Promise<"archived" | "kept" | "skipped"> {
  const workspaceId = ports.workspaceOf(agentId);
  if (!workspaceId) return "skipped";
  const keep = (why: string) => {
    ports.log(`factory: kept workspace ${workspaceId} of archived agent ${agentId}: ${why}`);
    return "kept" as const;
  };
  try {
    const live = (await ports.liveAgentsIn(workspaceId))?.filter((id) => id !== agentId);
    if (!live) return keep("could not list its agents");
    if (live.length) return keep(`${live.length} live agent(s) remain`);
    const probe = await ports.worktree(workspaceId);
    if (probe.state !== "clean") return keep(probe.detail);
    await ports.archiveWorkspace(workspaceId);
    ports.log(`factory: archived workspace ${workspaceId} with agent ${agentId}`);
    return "archived";
  } catch (error) {
    return keep(`archive failed: ${(error as Error).message}`);
  }
}
