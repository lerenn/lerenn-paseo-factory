import type { FactoryServices, SpawnOptions } from "./extensions";
import type { FactoryHost } from "./host";
import { resolveAgentConfig } from "./spawn-config";

/** The services extensions get as `ctx.spawn`, `ctx.leases`, `ctx.warden` and `ctx.inbox`. */
export function buildServices(host: FactoryHost): FactoryServices {
  const need = (name: "leases" | "warden" | "inbox") => {
    if (!host.enabled(name) || !host.engines[name]) throw new Error(`The ${name} module is off.`);
    return host.engines[name];
  };
  return {
    async spawn(o: SpawnOptions) {
      const cwd = o.cwd ?? process.env.FACTORY_DEFAULT_CWD;
      if (!cwd) throw new Error("spawn needs a cwd");
      const role = o.role ? await host.loadRole(o.role) : null;
      const handle = await host.paseo.agents.create({
        config: resolveAgentConfig(role, process.env.FACTORY_DEFAULT_PROVIDER ?? "claude/claude-sonnet-5-5"),
        cwd,
        title: o.title,
        prompt: o.prompt,
        parent: o.parent,
        labels: { "paseo.factory": "1", ...(o.role ? { "paseo.factory.role": o.role } : {}), ...o.labels },
        env: { ...(o.role ? { PASEO_AGENT_ROLE: o.role } : {}), ...o.env },
      });
      return { agentId: handle.id };
    },
    leases: {
      acquire: (agentId, name, ttl, mode) => need("leases").acquire(agentId, name, ttl, mode),
      renew: (agentId, name, token, ttl) => need("leases").renew(agentId, name, token, ttl),
      release: (agentId, name, token) => need("leases").release(agentId, name, token),
      list: () => need("leases").views(),
    },
    warden: {
      register: ({ agentId, task, intervalMinutes, registeredBy }) => {
        const w = need("warden");
        return { taskId: w.register({ agentId, task, intervalMinutes: intervalMinutes ?? w.defaultIntervalMinutes(), until: null, registeredBy, source: "parent" }).id };
      },
      done: (taskId, result) => {
        const w = need("warden");
        const t = w.store.get(taskId);
        if (t && t.state === "active") w.finish(t, "done", result);
      },
    },
    inbox: {
      ask: ({ agentId, question, kind, context, dedupeKey }) => ({ itemId: need("inbox").ask({ agentId, question, kind, context, dedupeKey }).item.id }),
      withdraw: (itemId, reason) => {
        const e = need("inbox");
        const item = e.store.get(itemId);
        if (item && item.status === "pending") e.withdraw(item, "extension", reason ?? null);
      },
      status: (itemId) => {
        const item = need("inbox").store.get(itemId);
        return item ? { status: item.status, answer: item.answer?.optionId ?? item.answer?.text ?? null } : null;
      },
    },
  };
}
