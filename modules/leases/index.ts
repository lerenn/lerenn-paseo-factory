import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { countRpc, forceReleaseRpc, listLeasesRpc } from "./shared/rpc";
import { leasesSettings, type LeasesSettings } from "./shared/settings";
import { Engine, type Actions } from "./server/engine";
import { LeasesHttp } from "./server/http";
import { applyInjection, CAPABILITY_ENV, scopeApplies, SCOPE_ENV } from "./server/inject";
import { McpServer } from "./server/mcp";
import { Store } from "./server/store";
import { TOOLS } from "./server/tools";

const DEFAULT_PORT = 47826;

type Paseo = PluginHookContext["paseo"];
type HookAgent = { id: string; workspaceId: string | null; title: string | null };

export default function contribute(server: PluginServerContext) {
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
  const store = new Store(process.env.LEASES_STATE ?? undefined);
  const engine = new Engine(store, actions, () => current);

  // Wake agents right after a change instead of waiting for the next tick; a failure stays owed and the tick retries it.
  const flush = () => void engine.deliver().catch((error) => console.error("leases: deliver failed", error));

  const http = new LeasesHttp({ engine, mcp: new McpServer(TOOLS), onChange: flush });
  let url: string | null = null;
  let startError: string | null = null;
  const port = Number(process.env.LEASES_PORT ?? DEFAULT_PORT);
  // Resumed agents keep the URL they were created with, so the port has to be stable.
  const started = http.start(port).then(
    (u) => {
      url = u;
    },
    (err: Error) => {
      startError = `leases cannot listen on 127.0.0.1:${port}: ${err.message}. Set LEASES_PORT on the daemon.`;
      console.error(startError);
    },
  );

  const known = (agent: HookAgent) => store.upsertAgent(agent.id, { title: agent.title, workspaceId: agent.workspaceId });

  const removers = [
    server.before("agent.create", async ({ request }, ctx) => {
      capture(ctx);
      await ready;
      if (!current?.enabled || !scopeApplies(current.scope, request.env)) return;
      await started;
      if (!url) throw new Error(`${startError} Create the agent with ${SCOPE_ENV}=off to skip leases.`);
      return applyInjection(request, { url, capability: store.createSession() });
    }),
    server.before("agent.session_open", ({ request }, ctx) => {
      capture(ctx);
      const capability = request.env[CAPABILITY_ENV];
      if (capability) store.bind(capability, request.agentId);
      store.upsertAgent(request.agentId, { optOut: request.env[SCOPE_ENV]?.toLowerCase() === "off" });
    }),
    server.on("agent.created", ({ agent }, ctx) => {
      capture(ctx);
      known(agent);
    }),
    server.on("agent.turn_started", ({ agent }, ctx) => {
      capture(ctx);
      known(agent);
    }),
    server.on("agent.permission_requested", ({ agent }, ctx) => {
      capture(ctx);
      engine.permission(agent.id, true);
    }),
    server.on("agent.permission_resolved", ({ agent }, ctx) => {
      capture(ctx);
      engine.permission(agent.id, false);
    }),
    server.on("agent.archived", ({ agent }, ctx) => {
      capture(ctx);
      engine.agentArchived(agent.id);
      store.forgetAgentSessions(agent.id);
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
      endpoint: { url, error: startError },
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
    void http.stop();
  };
}
