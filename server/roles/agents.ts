import type { RoleAgent } from "../../shared/roles/rpc";

type Listed = { id: string; title: string | null; status?: string; workspaceId: string | null; labels?: Record<string, string>; archivedAt?: string | null };
type Workspace = { id: string; projectCustomName?: string | null; projectDisplayName?: string | null; title?: string | null; name?: string | null };

/** Live agents with a role: the role from the session registry, else the Factory's role label. */
export function roleAgents(listed: Listed[], registry: Record<string, string>, workspaces: Workspace[]): RoleAgent[] {
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const out: RoleAgent[] = [];
  for (const a of listed) {
    if (a.archivedAt || a.status === "closed") continue;
    const role = registry[a.id] ?? a.labels?.["paseo.factory.role"];
    if (!role) continue;
    const ws = a.workspaceId ? byId.get(a.workspaceId) : undefined;
    out.push({
      id: a.id,
      title: a.title ?? null,
      role,
      status: a.status ?? "unknown",
      workspaceId: a.workspaceId,
      workspaceName: ws ? (ws.title || ws.name || null) : null,
      projectName: ws ? (ws.projectCustomName || ws.projectDisplayName || null) : null,
      run: a.labels?.["paseo.factory.run"] ?? null,
      blueprint: a.labels?.["paseo.factory.blueprint"] ?? null,
      stage: a.labels?.["paseo.factory.stage"] ?? null,
    });
  }
  return out.sort((x, y) => x.role.localeCompare(y.role) || (x.title ?? "").localeCompare(y.title ?? ""));
}
