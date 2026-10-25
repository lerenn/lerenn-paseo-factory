import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { answerRpc, countRpc, listItemsRpc, readRpc } from "./shared/rpc";
import { inboxSettings, type InboxSettings } from "./shared/settings";
import { Engine, type Actions } from "./server/engine";
import { InboxHttp } from "./server/http";
import { applyInjection, CAPABILITY_ENV, scopeApplies, SCOPE_ENV } from "./server/inject";
import { McpServer } from "./server/mcp";
import { Store } from "./server/store";
import { TOOLS } from "./server/tools";

const DEFAULT_PORT = 47825;

type Paseo = PluginHookContext["paseo"];
type HookAgent = { id: string; workspaceId: string | null; title: string | null };

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(inboxSettings);
  let current: InboxSettings | null = null;
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
  const store = new Store(process.env.INBOX_STATE ?? undefined);
  const engine = new Engine(store, actions, () => current);

  const http = new InboxHttp({ engine, mcp: new McpServer(TOOLS) });
  let url: string | null = null;
  let startError: string | null = null;
  const port = Number(process.env.INBOX_PORT ?? DEFAULT_PORT);
  // Resumed agents keep the URL they were created with, so the port has to be stable.
  const started = http.start(port).then(
    (u) => {
      url = u;
    },
    (err: Error) => {
      startError = `inbox cannot listen on 127.0.0.1:${port}: ${err.message}. Set INBOX_PORT on the daemon.`;
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
      if (!url) throw new Error(`${startError} Create the agent with ${SCOPE_ENV}=off to skip the inbox.`);
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
    }),
  ];

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const loop = async () => {
    try {
      await engine.tick();
    } catch (error) {
      console.error("inbox: tick failed", error);
    }
    if (!stopped) timer = setTimeout(loop, (current?.tickSeconds ?? 30) * 1000);
  };
  // Soon after start: re-deliver answers a restart interrupted and expire overdue items.
  timer = setTimeout(loop, 5_000);

  // Project and workspace names come from the workspace directory; looked up once per agent and kept.
  let namesCheckedAt = 0;
  async function resolveNames(ctx: { paseo: Paseo }) {
    const missing = store.all().filter((i) => {
      const a = store.agent(i.agentId);
      return a?.workspaceId && !(a.projectName && a.workspaceName);
    });
    if (missing.length === 0 || Date.now() - namesCheckedAt < 30_000) return;
    namesCheckedAt = Date.now();
    try {
      const { entries } = await ctx.paseo.workspaces.list();
      const byId = new Map(entries.map((w) => [w.id, w]));
      for (const item of missing) {
        const agent = store.agent(item.agentId);
        const ws = agent?.workspaceId ? byId.get(agent.workspaceId) : undefined;
        if (ws) store.upsertAgent(item.agentId, { projectName: ws.projectCustomName || ws.projectDisplayName, workspaceName: ws.title || ws.name });
      }
    } catch (error) {
      console.error("inbox: workspace lookup failed", error);
    }
  }

  server.handle(listItemsRpc, async ({ audit }, ctx) => {
    capture(ctx);
    await resolveNames(ctx);
    return {
      now: Date.now(),
      items: engine.views(),
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
  server.handle(answerRpc, async ({ itemId, optionId, text, comment }, ctx) => {
    capture(ctx);
    const result = engine.answer(itemId, { optionId, text, comment });
    // Deliver right away; a failure stays owed and the tick retries it.
    if (result.ok) void engine.deliver().catch((error) => console.error("inbox: deliver failed", error));
    return { ok: result.ok, message: result.message, item: result.item ? engine.view(result.item) : null };
  });
  server.handle(readRpc, ({ itemId }, ctx) => {
    capture(ctx);
    engine.markRead(itemId);
    return {};
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const remove of removers) remove();
    unsubscribeSettings();
    void http.stop();
  };
}
