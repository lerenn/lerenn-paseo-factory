import path from "node:path";
import type { FactoryHost } from "../../server/host";
import { HttpError } from "../../server/host";
import { MODULE_NOTE } from "./server/note";
import { Engine, NotFoundError, UsageError, type Ports } from "./server/engine";
import { ghFacts } from "./server/github";
import { loadCatalog, type Catalog } from "./server/loader";
import { RunStore } from "./server/store";
import { blueprintTools, INSTRUCTIONS, TOOL_NAMES, WORKER_TOOL_NAMES } from "./server/tools";
import { abortRunRpc, listRunsRpc, retryRunRpc, startRunRpc } from "./shared/rpc";
import { blueprintsSettings, type BlueprintsSettings } from "./shared/settings";

export function startBlueprints(host: FactoryHost) {
  const { server } = host;
  const settings = server.registerSettings(blueprintsSettings);
  let current: BlueprintsSettings | null = null;
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    current = state.status === "ready" ? state.values : null;
  };
  const ready = settings.read().then(apply);
  const unsubscribeSettings = settings.subscribe(apply);
  const cfg = (): BlueprintsSettings => current ?? ({ defaultProvider: "claude", pmRole: "pm", pollSeconds: 60, idleGraceSeconds: 90, archiveOnFinish: false } as BlueprintsSettings);

  // ---- the catalog: blueprints/*.toml of the git sources, plus an optional local folder ----
  let catalog: Catalog = { blueprints: new Map(), errors: [] };
  let catalogAt = 0;
  async function refresh(force = false): Promise<Catalog> {
    if (!force && Date.now() - catalogAt < 15_000) return catalog;
    catalogAt = Date.now();
    const dirs: string[] = [];
    if (process.env.FACTORY_BLUEPRINTS_DIR) dirs.push(process.env.FACTORY_BLUEPRINTS_DIR);
    for (const source of await host.configuredSources()) if (host.gitSources) dirs.push(host.gitSources.subDir(source, "blueprints"));
    catalog = await loadCatalog(dirs);
    return catalog;
  }
  void refresh(true);

  const store = new RunStore(process.env.BLUEPRINTS_STATE ?? host.statePath("blueprints"));

  const inbox = () => {
    if (!host.enabled("inbox") || !host.engines.inbox) throw new Error("Gates need the Inbox module; switch it on in the Factory settings.");
    return host.engines.inbox as import("../inbox/server/engine").Engine;
  };
  const agentRef = (id: string) => host.paseo.agents.ref(id);

  const ports: Ports = {
    now: Date.now,
    async spawn(o) {
      const cwd = o.cwd ?? cfg().defaultCwd;
      if (!cwd) throw new Error("No working directory: set defaultCwd in the Blueprints settings, or cwd on the stage.");
      const handle = await host.paseo.agents.create({
        idempotencyKey: o.idempotencyKey,
        config: { provider: cfg().defaultProvider },
        cwd,
        title: o.title,
        prompt: o.prompt,
        labels: o.labels,
        env: o.env,
      });
      return { agentId: handle.id };
    },
    async send(agentId, text) {
      await agentRef(agentId).send(text, { activeTurnBehavior: "steer" });
    },
    async agentState(agentId) {
      try {
        const found = await agentRef(agentId).refresh();
        if (!found || found.agent.archivedAt) return "gone";
        return found.agent.status === "running" || found.agent.status === "initializing" ? "running" : found.agent.status === "closed" ? "gone" : "idle";
      } catch {
        return "gone";
      }
    },
    async archive(agentId) {
      await agentRef(agentId).archive();
    },
    ask(o) {
      const { item } = inbox().ask({
        agentId: `blueprint:${o.runId}`,
        question: o.question,
        kind: o.kind,
        options: o.options.length ? o.options : undefined,
        allowFreeText: o.freeText,
        context: o.context,
        blocking: false,
        dedupeKey: o.dedupeKey,
        expiresInMinutes: o.expiresInMinutes,
        internal: true,
      });
      return { itemId: item.id };
    },
    gate(itemId) {
      const item = inbox().store.get(itemId);
      if (!item) return null;
      return { status: item.status, optionId: item.answer?.optionId ?? null, text: item.answer?.text ?? item.comment, by: item.answer?.by ?? null };
    },
    withdraw(itemId, reason) {
      const e = inbox();
      const item = e.store.get(itemId);
      if (item && item.status === "pending") e.withdraw(item, "blueprints", reason);
    },
    wardenRegister({ agentId, task }) {
      if (!host.enabled("warden") || !host.engines.warden) return null;
      const w = host.engines.warden;
      return w.register({ agentId, task, intervalMinutes: w.defaultIntervalMinutes(), until: null, registeredBy: "factory", source: "parent" }).id;
    },
    wardenDone(taskId, result) {
      const w = host.engines.warden;
      const task = w?.store.get(taskId);
      if (task && task.state === "active") w.finish(task, "done", result);
    },
    prFacts: ghFacts,
    tool: (name) => host.toolRunner(name),
    stageKind(kind) {
      for (const ext of host.listExtensions()) {
        const found = ext.stageKinds.find((k) => k.kind === kind);
        if (found) {
          return (ctx) => found.run({ ...ctx, paseo: host.paseo, services: host.services as never, signal: new AbortController().signal });
        }
      }
      return null;
    },
    blueprint: (name) => catalog.blueprints.get(name),
    settings: () => ({ defaultCwd: cfg().defaultCwd, pmRole: cfg().pmRole, idleGraceSeconds: cfg().idleGraceSeconds, archiveOnFinish: cfg().archiveOnFinish }),
  };
  const engine = new Engine(store, ports);

  const removeTools = host.registerTools("blueprints", blueprintTools({ engine, catalog: async () => (await refresh()).blueprints }));
  host.setInstructions("blueprints", INSTRUCTIONS);
  host.contribute({
    module: "blueprints",
    note: MODULE_NOTE,
    tools(request) {
      if (request.env?.PASEO_FACTORY_RUN) return WORKER_TOOL_NAMES;
      return request.env?.PASEO_FACTORY_BLUEPRINTS === "on" || request.env?.PASEO_AGENT_ROLE === cfg().pmRole ? TOOL_NAMES : null;
    },
  });

  host.blueprints = {
    list() {
      return [...catalog.blueprints.values()].map(({ blueprint }) => ({
        name: blueprint.name,
        description: blueprint.description,
        vars: Object.entries(blueprint.vars).map(([name, v]) => ({ name, required: v.required, description: v.description })),
      }));
    },
    start(input) {
      try {
        return { runId: engine.start({ blueprint: input.blueprint, vars: input.vars, requestedBy: input.requestedBy, idempotencyKey: input.idempotencyKey }).id };
      } catch (error) {
        if (error instanceof NotFoundError) throw new HttpError(404, error.message);
        if (error instanceof UsageError) throw new HttpError(400, error.message);
        throw error;
      }
    },
  };

  // ---- events ----
  const removers = [
    host.on("blueprints", "agent.turn_ended", ({ agent, outcome }) => {
      void engine.turnEnded(agent.id, { kind: outcome.kind, message: outcome.kind === "failed" ? outcome.error.message : undefined }).catch((e) => console.error("blueprints: turn_ended failed", e));
    }),
  ];
  const unlisten = host.engines.inbox?.onResolved((item: { id: string; agentId: string }) => {
    if (item.agentId.startsWith("blueprint:")) void engine.gateResolved(item.id).catch((e) => console.error("blueprints: gate failed", e));
  });
  host.whenPaseo(() => void ready.then(() => engine.resumeAll()).catch((e) => console.error("blueprints: resume failed", e)));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const loop = async () => {
    try {
      if (host.enabled("blueprints") && host.hasPaseo()) await engine.tick();
    } catch (error) {
      console.error("blueprints: tick failed", error);
    }
    if (!stopped) timer = setTimeout(loop, cfg().pollSeconds * 1000);
  };
  timer = setTimeout(loop, 20_000);

  // ---- screens ----
  server.handle(listRunsRpc, async ({ includeFinished }, ctx) => {
    host.capture(ctx);
    await ready;
    const c = await refresh();
    return {
      now: Date.now(),
      runs: store
        .all()
        .filter((r) => includeFinished || r.endedAt === null)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((r) => engine.view(r)),
      blueprints: [...c.blueprints.values()].map(({ blueprint }) => ({
        name: blueprint.name,
        description: blueprint.description,
        vars: Object.entries(blueprint.vars).map(([name, v]) => ({ name, required: v.required, description: v.description })),
        stages: blueprint.stage.map((s) => s.id),
      })),
      errors: c.errors.map((e) => ({ file: path.basename(e.file), message: e.message })),
      settings: current,
    };
  });
  server.handle(startRunRpc, async ({ blueprint, vars, at }, ctx) => {
    host.capture(ctx);
    await refresh();
    try {
      return { ok: true, runId: engine.start({ blueprint, vars, at, requestedBy: "user" }).id, message: null };
    } catch (error) {
      return { ok: false, runId: null, message: (error as Error).message };
    }
  });
  server.handle(abortRunRpc, async ({ runId }, ctx) => {
    host.capture(ctx);
    try {
      await engine.abort(runId, "aborted from the Blueprints tab");
      return { ok: true, message: null };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
  server.handle(retryRunRpc, async ({ runId, stage, extraAttempts }, ctx) => {
    host.capture(ctx);
    try {
      await engine.resume(runId, { stage, extraAttempts });
      return { ok: true, message: null };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const remove of removers) remove();
    unlisten?.();
    unsubscribeSettings();
    removeTools();
    host.blueprints = null;
  };
}
