import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { FactoryHost } from "../../server/host";
import { adapt } from "../../server/tools";
import { cancelTaskRpc, commandRpc, listTasksRpc } from "./shared/rpc";
import { wardenSettings, type WardenSettings } from "./shared/settings";
import { parseCommand, runCommand } from "./server/command";
import { analyze, lastAssistantText } from "./server/classify";
import { Engine, type Actions } from "./server/engine";
import { INTERVAL_ENV, parseInterval } from "./server/interval";
import { envValue, NOTE, scopeApplies, SCOPE_ENV, TOOL_NAMES } from "./server/inject";
import { INSTRUCTIONS } from "./server/instructions";
import { Store } from "./server/store";
import { TOOLS } from "./server/tools";

type Paseo = PluginHookContext["paseo"];
type HookAgent = { id: string; workspaceId: string | null; parentAgentId: string | null; title: string | null };

export function startWarden(host: FactoryHost) {
  const { server } = host;
  const settings = server.registerSettings(wardenSettings);
  let current: WardenSettings | null = null;
  let settingsError: string | null = null;
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    current = state.status === "ready" ? state.values : null;
    settingsError = state.status === "invalid" ? state.error : null;
  };
  const ready = settings.read().then(apply);
  const unsubscribeSettings = settings.subscribe(apply);

  // Hooks hand us the daemon-side SDK; keep the latest for timers and observers.
  let paseo: Paseo | null = null;
  const capture = (ctx: { paseo: Paseo }) => {
    if (paseo === null) {
      paseo = ctx.paseo;
      engine.resume();
    }
    paseo = ctx.paseo;
  };

  const watchers = new Map<string, () => void>();
  const actions: Actions = {
    async send(agentId, text) {
      if (!paseo) throw new Error("Paseo API not available yet");
      await paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    },
    watch(agentId) {
      if (watchers.has(agentId) || !paseo) return;
      const subscription = paseo.agents.ref(agentId).timeline.subscribe((event) => {
        // Warden's own prompt arrives as a user message; it is not the agent doing something.
        const item = (event as { event?: { item?: { type?: string } } }).event?.item;
        if (item?.type === "user_message") {
          engine.userMessage(agentId);
          return;
        }
        engine.activity(agentId);
      });
      watchers.set(agentId, () => (subscription as unknown as () => void)());
    },
    unwatch(agentId) {
      watchers.get(agentId)?.();
      watchers.delete(agentId);
    },
  };
  const store = new Store(process.env.WARDEN_STATE ?? process.env.WARDER_STATE ?? host.statePath("warden", "agents-warden"));
  const engine = new Engine(store, actions, () => current);
  host.engines.warden = engine;
  const removeTools = host.registerTools("warden", TOOLS.map((t) => adapt(t, engine)));
  host.setInstructions("warden", INSTRUCTIONS);
  host.contribute({
    module: "warden",
    note: NOTE,
    async tools(request) {
      await ready;
      // A bad interval fails creation loudly instead of silently dropping the default.
      const asked = envValue(request.env, INTERVAL_ENV);
      if (asked) parseInterval(asked);
      return current?.enabled && scopeApplies(current.scope, request.env) ? TOOL_NAMES : null;
    },
  });

  const known = (agent: HookAgent) => {
    const result = store.upsertAgent(agent.id, { title: agent.title, parentId: agent.parentAgentId, workspaceId: agent.workspaceId });
    engine.childSeen(agent.id);
    return result;
  };

  const removers = [
    server.before("agent.session_open", ({ request }, ctx) => {
      capture(ctx);
      const interval = envValue(request.env, INTERVAL_ENV);
      let defaultIntervalMinutes: number | undefined;
      try {
        defaultIntervalMinutes = interval ? parseInterval(interval) : undefined;
      } catch (error) {
        console.error(`warden: ${(error as Error).message}`);
      }
      store.upsertAgent(request.agentId, { optOut: envValue(request.env, SCOPE_ENV)?.toLowerCase() === "off", defaultIntervalMinutes });
    }),
    host.on("warden", "agent.created", ({ agent }, ctx) => {
      capture(ctx);
      known(agent);
    }),
    host.on("warden", "agent.turn_started", ({ agent }, ctx) => {
      capture(ctx);
      known(agent);
      engine.turnStarted(agent.id);
    }),
    host.on("warden", "agent.turn_ended", ({ agent, timeline }, ctx) => {
      capture(ctx);
      known(agent);
      engine.turnEnded(agent.id);
      const heuristics = current?.announcedWork;
      if (!heuristics?.enabled || store.optedOut(agent.id) || store.active(agent.id).length > 0) return;
      const report = analyze(lastAssistantText(timeline as { type: string; text?: string }[]));
      if (report.announcesFutureWork && report.lastStep) {
        engine.register({
          agentId: agent.id,
          task: report.lastStep,
          intervalMinutes: heuristics.intervalMinutes,
          until: null,
          registeredBy: agent.id,
          source: "announced-work",
        });
      }
    }),
    host.on("warden", "agent.permission_requested", ({ agent }, ctx) => {
      capture(ctx);
      engine.permission(agent.id, true);
    }),
    host.on("warden", "agent.permission_resolved", ({ agent }, ctx) => {
      capture(ctx);
      engine.permission(agent.id, false);
    }),
    host.on("warden", "agent.archived", ({ agent }, ctx) => {
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
      console.error("warden: tick failed", error);
    }
    if (!stopped) timer = setTimeout(loop, (current?.tickSeconds ?? 60) * 1000);
  };
  timer = setTimeout(loop, 15_000);

  // Project and workspace names come from the workspace directory; looked up once per agent and kept.
  let namesCheckedAt = 0;
  async function resolveNames(ctx: { paseo: Paseo }) {
    const ids = [...store.all().map((t) => t.agentId)];
    const missing = ids.filter((id) => {
      const a = store.agent(id);
      return a?.workspaceId && !(a.projectName && a.workspaceName);
    });
    if (missing.length === 0 || Date.now() - namesCheckedAt < 30_000) return;
    namesCheckedAt = Date.now();
    try {
      const { entries } = await ctx.paseo.workspaces.list();
      const byId = new Map(entries.map((w) => [w.id, w]));
      for (const id of missing) {
        const agent = store.agent(id);
        const ws = agent?.workspaceId ? byId.get(agent.workspaceId) : undefined;
        if (ws) {
          store.upsertAgent(id, {
            projectName: ws.projectCustomName || ws.projectDisplayName,
            workspaceName: ws.title || ws.name,
          });
        }
      }
    } catch (error) {
      console.error("warden: workspace lookup failed", error);
    }
  }

  // Children created before warden saw them are only known through the agent list. The list holds
  // the live agents only, so a known child missing from it, or closed, was archived without warden noticing.
  let reconciledAt = 0;
  async function seedChildren(ctx: { paseo: Paseo }, extra?: string) {
    if (!extra && Date.now() - reconciledAt < 30_000) return;
    reconciledAt = Date.now();
    try {
      const { entries } = await ctx.paseo.agents.list({ filter: { includeArchived: false } } as never);
      type Listed = { id: string; title: string | null; workspaceId: string | null; status?: string; parentAgentId?: string | null; labels?: Record<string, string> };
      const live = new Map<string, Listed>();
      for (const { agent } of entries as { agent: Listed }[]) if (agent.status !== "closed") live.set(agent.id, agent);
      const supervisors = new Set([...store.active().map((t) => t.agentId), ...(extra ? [extra] : [])]);
      for (const agent of live.values()) {
        const parent = agent.parentAgentId ?? agent.labels?.["paseo.parent-agent-id"] ?? null;
        if (!supervisors.has(agent.id) && !(parent && supervisors.has(parent))) continue;
        store.upsertAgent(agent.id, { title: agent.title, parentId: parent, workspaceId: agent.workspaceId });
        engine.childSeen(agent.id);
      }
      for (const sup of supervisors) {
        if (!live.has(sup)) continue; // a truncated or odd list must not archive everything
        for (const child of store.children(sup)) if (!live.has(child)) engine.agentArchived(child);
      }
    } catch (error) {
      console.error("warden: agent lookup failed", error);
    }
  }

  server.handle(commandRpc, async ({ agentId, args }, ctx) => {
    capture(ctx);
    await ready;
    const command = parseCommand(args);
    if (command.kind === "watch") {
      store.upsertAgent(agentId, {});
      await seedChildren(ctx, agentId);
    }
    const message = await runCommand(engine, agentId, command);
    try {
      await ctx.paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: `warden-${Date.now()}`, kind: "warden-note", version: 1, data: { text: message } });
    } catch (error) {
      console.error("warden: could not append the command result", error);
    }
    return { message };
  });
  server.handle(listTasksRpc, async (_input, ctx) => {
    capture(ctx);
    await seedChildren(ctx);
    await resolveNames(ctx);
    return { now: Date.now(), tasks: engine.views(), settings: current, settingsError, endpoint: { url: host.url, error: host.startError } };
  });
  server.handle(cancelTaskRpc, ({ taskId }, ctx) => {
    capture(ctx);
    const task = store.get(taskId);
    if (task?.state === "active") engine.finish(task, "cancelled");
    return {};
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const remove of removers) remove();
    for (const stop of watchers.values()) stop();
    watchers.clear();
    unsubscribeSettings();
    removeTools();
  };
}
