import type { Paseo } from "./host";

/**
 * Every live agent the Factory must see. `agents.list` leaves out agents of BACKGROUND workspaces (pods, Factory-created
 * workspaces) unless `includeBackground` is set; without it the Factory would think those agents are gone (Warden would
 * drop their watches, the digest and the badge lookups would miss them).
 */
export function listAgents(paseo: Paseo) {
  return paseo.agents.list({ filter: { includeArchived: false, includeBackground: true } } as never);
}
