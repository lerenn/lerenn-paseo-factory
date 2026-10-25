import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { FactoryHost } from "../../server/host";
import { adapt } from "../../server/tools";
import { countRpc, forceReleaseRpc, listLeasesRpc } from "./shared/rpc";
import { leasesSettings, type LeasesSettings } from "./shared/settings";
import { Engine, type Actions } from "./server/engine";
import { NOTE, scopeApplies, SCOPE_ENV, TOOL_NAMES } from "./server/inject";
import { INSTRUCTIONS } from "./server/instructions";
import { Store } from "./server/store";
import { TOOLS } from "./server/tools";

type Paseo = PluginHookContext["paseo"];
type HookAgent = { id: string; workspaceId: string | null; title: string | null };

export function startLeases(host: FactoryHost) {
  const { server } = host;
  const settings = server.registerSettings(leasesSettings);
  let current: LeasesSettings | null = null;
  let settingsError: string | null = null;
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    current = state.status === "ready" ? state.values : null;
    settingsError = state.status === "invalid" ? state.error : null;
  };
  const ready = settings.read().then(apply);
  const unsubscribeSettings = settings.subscribe(apply);

  // Hooks hand us the daemon-side SDK; keep the latest for timers.
  let paseo: Paseo | null = null;
  const capture = (ctx: { paseo: Paseo }) => {
    paseo = ctx.paseo;
  };

  const actions: Actions = {
    async send(agentId, text) {
      if (!paseo) throw new Error("Paseo API not available yet");
      await paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    },
    async isArchived(agentId) {
      if (!paseo) return false;
      const handle = paseo.agents.ref(agentId);
      await handle.refresh();
      return handle.archivedAt !== null;
    },
  };
  const store = new Store(process.env.LEASES_STATE ?? host.statePath("leases", "agents-leases"));
  const engine = new Engine(store, actions, () => current);
  host.engines.leases = engine;

  // Wake agents right after a change instead of waiting for the next tick; a failure stays owed and the tick retries it.
  const flush = () => void engine.deliver().catch((error) => console.error("leases: deliver failed", error));
  const removeTools = host.registerTools("leases", TOOLS.map((t) => adapt(t, engine)));
  host.setInstructions("leases", INSTRUCTIONS);
  host.afterCall.push(flush);
  host.contribute({
    module: "leases",
    note: NOTE,
    async tools(request) {
      await ready;
      return current?.enabled && scopeApplies(current.scope, request.env) ? TOOL_NAMES : null;
    },
  });

  const known = (agent: HookAgent) => store.upsertAgent(agent.id, { title: agent.title, workspaceId: agent.workspaceId });

  const removers = [
    server.before("agent.session_open", ({ request }, ctx) => {
      capture(ctx);
      store.upsertAgent(request.agentId, { optOut: request.env[SCOPE_ENV]?.toLowerCase() === "off" });
    }),
    host.on("leases", "agent.created", ({ agent }, ctx) => {
      capture(ctx);
      known(agent);
    }),
    host.on("leases", "agent.turn_started", ({ agent }, ctx) => {
      capture(ctx);
      known(agent);
    }),
    host.on("leases", "agent.permission_requested", ({ agent }, ctx) => {
      capture(ctx);
      engine.permission(agent.id, true);
    }),
    host.on("leases", "agent.permission_resolved", ({ agent }, ctx) => {
      capture(ctx);
      engine.permission(agent.id, false);
    }),
    host.on("leases", "agent.archived", ({ agent }, ctx) => {
      capture(ctx);
      engine.agentArchived(agent.id);
      flush();
    }),
  ];

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const loop = async () => {
    try {
      await engine.tick();
    } catch (error) {
      console.error("leases: tick failed", error);
    }
    if (!stopped) timer = setTimeout(loop, (current?.tickSeconds ?? 10) * 1000);
  };
  // Soon after start: expire overdue leases and re-deliver messages a restart interrupted.
  timer = setTimeout(loop, 5_000);

  server.handle(listLeasesRpc, ({ audit }, ctx) => {
    capture(ctx);
    return {
      now: Date.now(),
      leases: engine.views(),
      events: audit ? store.events().slice(-500) : [],
      settings: current,
      settingsError,
      endpoint: { url: host.url, error: host.startError },
    };
  });
  server.handle(countRpc, (_input, ctx) => {
    capture(ctx);
    return engine.count();
  });
  server.handle(forceReleaseRpc, ({ name }, ctx) => {
    capture(ctx);
    const result = engine.forceRelease(name);
    flush();
    return result;
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const remove of removers) remove();
    unsubscribeSettings();
    removeTools();
  };
}
