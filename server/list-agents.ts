import type { Paseo } from "./host";
import { agentExcluded } from "./exclusions";

/**
 * Every live agent the Factory must see. `agents.list` leaves out agents of BACKGROUND workspaces (pods, Factory-created
 * workspaces) unless `includeBackground` is set; without it the Factory would think those agents are gone (Warden would
 * drop their watches, the digest and the badge lookups would miss them).
 * Agents in an excluded project (the Security coordinator's) are dropped: the Factory never watches or digests them.
 */
export async function listAgents(paseo: Paseo): Promise<{ entries: { agent: any }[] } & Record<string, unknown>> {
  const result = (await paseo.agents.list({ filter: { includeArchived: false, includeBackground: true } } as never)) as unknown as { entries: { agent: { id: string; cwd?: string | null } }[] };
  return { ...result, entries: result.entries.filter((e) => !agentExcluded(e.agent)) };
}
