export const FACTORY_LABEL = "paseo.factory";

export interface LiveAgent {
  id: string;
  status?: string;
  labels?: Record<string, string>;
}

/**
 * Which active watches must go: those of archived or vanished agents, and of agents the Factory did not start.
 * An empty list of live agents drops nothing (more likely a hiccup than an empty daemon).
 */
export function watchesToDrop<T extends { agentId: string }>(tasks: readonly T[], live: readonly LiveAgent[]): { task: T; why: "archived" | "not-factory" }[] {
  if (live.length === 0) return [];
  const byId = new Map(live.map((a) => [a.id, a]));
  const out: { task: T; why: "archived" | "not-factory" }[] = [];
  for (const task of tasks) {
    const agent = byId.get(task.agentId);
    if (!agent || agent.status === "closed") out.push({ task, why: "archived" });
    else if (agent.labels?.[FACTORY_LABEL] !== "1") out.push({ task, why: "not-factory" });
  }
  return out;
}
