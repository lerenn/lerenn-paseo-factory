import path from "node:path";

/** Where the Factory must not look or spawn: excluded projects (by path, since an agent there may be recreated with a new id) and optional agent ids. */
export interface Exclusions {
  paths: string[];
  agents: string[];
}

let current: Exclusions = { paths: [], agents: [] };

export function setExclusions(next: Exclusions): void {
  current = { paths: next.paths.map((p) => path.resolve(p)), agents: [...next.agents] };
}

export function getExclusions(): Exclusions {
  return current;
}

export function pathExcluded(cwd: string | null | undefined, ex: Exclusions = current): boolean {
  if (!cwd) return false;
  const resolved = path.resolve(cwd);
  return ex.paths.some((p) => resolved === p || resolved.startsWith(`${p}${path.sep}`));
}

export function agentExcluded(agent: { id: string; cwd?: string | null }, ex: Exclusions = current): boolean {
  return ex.agents.includes(agent.id) || pathExcluded(agent.cwd, ex);
}
