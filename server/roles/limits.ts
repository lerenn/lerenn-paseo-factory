import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const defaultRegistryPath = path.join(homedir(), ".paseo", "agents-roles", "role-agents.json");

/** What a role's limit cares about: is this agent working, idle/finished, or gone. */
export type AgentActivity = "active" | "inactive" | "gone";

const RESERVATION_MS = 2 * 60_000;

/**
 * Tracks which agents run as which role so `maxConcurrent` can be enforced. The agent.create hook
 * runs before an agent has an id, so a slot is reserved there and turned into a registered agent
 * when the session opens (agent.session_open carries the id and the role in its env). The registry
 * is a file, so a daemon restart does not forget running agents.
 */
export class RoleLimits {
  private reservations: { role: string; at: number }[] = [];

  constructor(
    private readonly file: string = defaultRegistryPath,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  private write(agents: Record<string, string>) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(agents));
  }

  /** Every agent the registry knows, by role. */
  registered(): Record<string, string> {
    return this.read();
  }

  /** Record that `agentId` runs as `role` (idempotent). A new agent consumes one reservation. */
  register(agentId: string, role: string, created: boolean) {
    const agents = this.read();
    if (agents[agentId] !== role) this.write({ ...agents, [agentId]: role });
    if (created) {
      const i = this.reservations.findIndex((r) => r.role === role);
      if (i >= 0) this.reservations.splice(i, 1);
    }
  }

  /**
   * Take a slot for a new agent of `role`, or throw saying the role is full. `activity` reports
   * the live state of a registered agent; those that are gone are forgotten. `superseded` names agents that no longer
   * hold a place (a Factory worker no active stage refers to): they are not counted even while a turn still runs.
   */
  async reserve(role: string, max: number, activity: (agentId: string) => Promise<AgentActivity>, superseded?: (agentId: string) => boolean): Promise<void> {
    const cutoff = this.now() - RESERVATION_MS;
    this.reservations = this.reservations.filter((r) => r.at > cutoff);
    const agents = this.read();
    const gone: string[] = [];
    let active = 0;
    for (const [id, name] of Object.entries(agents)) {
      if (name !== role) continue;
      if (superseded?.(id)) continue;
      const state = await activity(id);
      if (state === "active") active++;
      else if (state === "gone") gone.push(id);
    }
    if (gone.length) {
      for (const id of gone) delete agents[id];
      this.write(agents);
    }
    const pending = this.reservations.filter((r) => r.role === role).length;
    if (active + pending >= max) {
      throw new Error(
        `Role "${role}" is at its limit of ${max} concurrent agent${max === 1 ? "" : "s"} ` +
          `(${active + pending} running or starting). Wait for one to finish, then try again.`,
      );
    }
    this.reservations.push({ role, at: this.now() });
  }
}
