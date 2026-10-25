import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { FactoryHost } from "../host";
import { adapt } from "../tools";
import { answerRpc, countRpc, listItemsRpc, readRpc } from "../../shared/inbox/rpc";
import { inboxSettings, type InboxSettings } from "../../shared/inbox/settings";
import { Engine, type Actions } from "./engine";
import { NOTE, scopeApplies, SCOPE_ENV, TOOL_NAMES } from "./inject";
import { INSTRUCTIONS } from "./instructions";
import { Store } from "./store";
import { TOOLS } from "./tools";

type Paseo = PluginHookContext["paseo"];
type HookAgent = { id: string; workspaceId: string | null; title: string | null };

export function startInbox(host: FactoryHost) {
  const { server } = host;
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
  const store = new Store(process.env.INBOX_STATE ?? host.statePath("inbox", "agents-inbox"));
  const engine = new Engine(store, actions, () => current);
  host.engines.inbox = engine;
  const removeTools = host.registerTools("inbox", TOOLS.map((t) => adapt(t, engine)));
  host.setInstructions("inbox", INSTRUCTIONS);
  host.contribute({
    module: "inbox",
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
    host.on("inbox", "agent.created", ({ agent }, ctx) => {
      capture(ctx);
      known(agent);
    }),
    host.on("inbox", "agent.turn_started", ({ agent }, ctx) => {
      capture(ctx);
      known(agent);
    }),
    host.on("inbox", "agent.permission_requested", ({ agent }, ctx) => {
      capture(ctx);
      engine.permission(agent.id, true);
    }),
    host.on("inbox", "agent.permission_resolved", ({ agent }, ctx) => {
      capture(ctx);
      engine.permission(agent.id, false);
    }),
    host.on("inbox", "agent.archived", ({ agent }, ctx) => {
      capture(ctx);
      engine.agentArchived(agent.id);
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
      endpoint: { url: host.url, error: host.startError },
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
    removeTools();
  };
}
