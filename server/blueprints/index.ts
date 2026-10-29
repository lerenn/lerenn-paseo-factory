import { AttentionNotifier, attentionPoints } from "./attention";
import { agentlessWorkspaces, factoryWorkspaceTitles, type ListedAgent, type ListedWorkspace } from "./orphans";
import path from "node:path";
import type { FactoryHost } from "../host";
import { HttpError } from "../host";
import { MODULE_NOTE } from "./note";
import { Engine, NotFoundError, UsageError, type Ports } from "./engine";
import { ghDiff, ghFacts } from "./github";
import { loadCatalog, type Catalog } from "./loader";
import { aggregate, SpendStore } from "./spend";
import { resolveAgentConfig } from "../spawn-config";
import { spawnAgent } from "../spawn-agent";
import { statusTrace } from "./worktree";
import { suspendPod, wakePod } from "./pod-control";
import { archiveWorkspaceWithAgent } from "./archive-workspace";
import { listAgents } from "../list-agents";
import { RunStore } from "./store";
import { retitleFactoryWorkspaces } from "../workspace-title";
import { blueprintTools, INSTRUCTIONS, TOOL_NAMES, WORKER_TOOL_NAMES } from "./tools";
import { stageVerdicts, type AgentStage, type Blueprint, type BlueprintStage, type CallStage, type GateStage } from "../../shared/blueprints/blueprint";
import type { BlueprintInfo, StageDetail } from "../../shared/blueprints/rpc";
import { abortRunRpc, listRunsRpc, retryRunRpc, runDiffRpc, spendRpc, startRunRpc, suspendRunsRpc } from "../../shared/blueprints/rpc";
import { blueprintsSettings, DEFAULT_RETRO_PROMPT, type BlueprintsSettings } from "../../shared/blueprints/settings";

/** What the Blueprints tab shows about a loaded blueprint. */
function describe({ blueprint, text, source }: { blueprint: Blueprint; text: string; source: string }): BlueprintInfo {
  return {
    name: blueprint.name,
    description: blueprint.description,
    vars: Object.entries(blueprint.vars).map(([name, v]) => ({ name, required: v.required, description: v.description })),
    stages: blueprint.stage.map((st) => st.id),
    source,
    pmExtraMax: blueprint.pm_extra_max,
    confirm: blueprint.confirm,
    text,
    details: blueprint.stage.map((st): StageDetail => {
      const kind = st.kind ?? "agent";
      const a = kind === "agent" ? (st as AgentStage) : null;
      const g = kind === "gate" ? (st as GateStage) : null;
      return {
        id: st.id,
        kind,
        title: st.title ?? null,
        role: a?.role ?? (kind === "call" ? ((st as CallStage).role ?? null) : null),
        agent: a?.agent ?? null,
        verdicts: stageVerdicts(st),
        on: st.on,
        maxAttempts: a?.max_attempts ?? null,
        maxRuns: a?.max_runs ?? null,
        flakeRetries: a?.flake_retries ?? null,
        skipIf: st.skip_if ?? null,
        facts: a?.facts ?? null,
        verify: a?.verify ?? {},
        gate: g ? { question: g.question, pr: g.pr ?? null, criteria: !!g.criteria, freeText: g.free_text, storeAs: g.store_as ?? null, noteTo: g.note_to ?? null } : null,
        tool: kind === "call" ? (st as CallStage).tool : null,
        childBlueprint: kind === "blueprint" ? (st as BlueprintStage).blueprint : null,
        usesLease: a ? /lease/i.test(a.prompt) : false,
      };
    }),
  };
}

const ORPHAN_SWEEP_MS = 5 * 60_000;

export function startBlueprints(host: FactoryHost) {
  const { server } = host;
  const settings = server.registerSettings(blueprintsSettings);
  let current: BlueprintsSettings | null = null;
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    current = state.status === "ready" ? state.values : null;
  };
  const ready = settings.read().then(apply);
  const unsubscribeSettings = settings.subscribe(apply);
  const cfg = (): BlueprintsSettings => current ?? ({ defaultProvider: "claude", pmRole: "pm", pollSeconds: 60, idleGraceSeconds: 90, archiveOnFinish: false, archiveWorkspaceWithAgent: true, events: { mailTo: "" }, retro: { enabled: true, mailTo: "", role: "retro", maxUsd: 0.3, timeoutMinutes: 10, skipTrivial: true, prompt: DEFAULT_RETRO_PROMPT }, janitor: { enabled: false, dryRun: true, orphanSweep: true } } as BlueprintsSettings);

  // ---- the catalog: blueprints/*.toml of the git sources, plus an optional local folder ----
  let catalog: Catalog = { blueprints: new Map(), errors: [] };
  let catalogAt = 0;
  let loading: Promise<Catalog> | null = null;
  function refresh(force = false): Promise<Catalog> {
    if (loading) return loading;
    if (!force && Date.now() - catalogAt < 15_000) return Promise.resolve(catalog);
    loading = (async () => {
      const dirs: { dir: string; label: string }[] = [];
      if (process.env.FACTORY_BLUEPRINTS_DIR) dirs.push({ dir: process.env.FACTORY_BLUEPRINTS_DIR, label: "local folder" });
      for (const source of (await host.configuredSources()) as { url: string; ref?: string; path?: string }[]) {
        if (host.gitSources) dirs.push({ dir: host.gitSources.subDir(source, "blueprints"), label: `${source.url.replace(/^.*[:/]([^/:]+\/[^/]+?)(\.git)?$/, "$1")}@${source.ref ?? "default"}:${source.path ? `${source.path}/` : ""}blueprints` });
      }
      catalog = await loadCatalog(dirs);
      catalogAt = Date.now();
      return catalog;
    })().finally(() => {
      loading = null;
    });
    return loading;
  }
  void refresh(true);

  const spend = new SpendStore(process.env.BLUEPRINTS_SPEND ?? host.statePath("blueprints").replace(/blueprints\.json$/, "spend.json"));
  const store = new RunStore(process.env.BLUEPRINTS_STATE ?? host.statePath("blueprints"));

  const inbox = () => {
    if (!host.enabled("inbox") || !host.engines.inbox) throw new Error("Gates need the Inbox module; switch it on in the Factory settings.");
    return host.engines.inbox as import("../inbox/engine").Engine;
  };
  const agentRef = (id: string) => host.paseo.agents.ref(id);

  const liveAgentsIn = async (workspaceId: string): Promise<string[] | null> => {
    try {
      const { entries } = await listAgents(host.paseo);
      return (entries as { agent: { id: string; workspaceId?: string | null; archivedAt?: string | null; status?: string } }[])
        .filter(({ agent: a }) => a.workspaceId === workspaceId && !a.archivedAt && a.status !== "closed")
        .map(({ agent: a }) => a.id);
    } catch {
      return null;
    }
  };

  /** Spawns in progress: a workspace made whose agent does not exist yet must not be taken for an orphan. */
  let spawning = 0;
  const ports: Ports = {
    now: Date.now,
    async spawn(o) {
      spawning++;
      try {
      const cwd = o.cwd ?? cfg().defaultCwd;
      if (!cwd) throw new Error("No working directory: set defaultCwd in the Blueprints settings, or cwd on the stage.");
      const role = await host.loadRole(o.role);
      const input = {
        idempotencyKey: o.idempotencyKey,
        config: resolveAgentConfig(role, cfg().defaultProvider) as never,
        cwd,
        title: o.title,
        workspaceTitle: o.workspaceTitle ?? o.title,
        prompt: o.prompt,
        labels: o.labels,
        env: o.env,
        // Recorded before the agent exists, so the orphan sweep finds the workspace even if the agent never comes.
        onWorkspaceCreated: (id: string) => store.noteWorkspace(id, { at: Date.now(), run: o.labels["paseo.factory.run"] ?? null, title: o.workspaceTitle ?? o.title }),
      };
      const runtime = o.runtime ?? host.runtime;
      const { agentId, workspaceId } = await spawnAgent(host.paseo, runtime, { ...input, joinWorkspaceId: o.joinWorkspaceId }).catch((error: Error) => {
        // The shared pod is gone (archived, evicted): this worker gets a pod of its own and becomes the new shared one.
        if (!o.joinWorkspaceId) throw error;
        console.error(`blueprints: joining workspace ${o.joinWorkspaceId} failed (${error.message}); creating a new one`);
        return spawnAgent(host.paseo, runtime, input);
      });
      return { agentId, workspaceId };
      } finally {
        spawning--;
      }
    },
    async send(agentId, text) {
      await agentRef(agentId).send(text, { activeTurnBehavior: "steer" });
    },
    report: (agentId, report) => host.report(agentId, report),
    runStarted: () => host.engines.supervisor?.wake(),
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
      await agentRef(agentId).archive().catch((error: Error) => {
        if (!/archived|not found|unknown/i.test(error.message)) throw error;
      });
    },
    async archiveWorkspace(workspaceId) {
      const result = await host.paseo.workspaces.archive(workspaceId);
      if (result.error && !/archived|not found|unknown/i.test(result.error)) throw new Error(result.error);
    },
    trace: (workspaceId) => statusTrace(host.paseo, workspaceId),
    liveAgentsIn,
    suspendWorkspace: suspendPod,
    wakeWorkspace: wakePod,
    spend(runId) {
      const total = aggregate(spend.all().filter((r) => r.run === runId)).total;
      return total.turns ? { costUsd: total.costUsd, turns: total.turns } : null;
    },
    spendOfAgent: (agentId) => spend.all().filter((r) => r.agentId === agentId).reduce((n, r) => n + r.costUsd, 0),
    post: () => ({ eventsMailTo: cfg().events.mailTo, retro: cfg().retro, janitor: cfg().janitor }),
    ask(o) {
      const e = inbox();
      e.store.upsertAgent(`blueprint:${o.runId}`, { title: o.title });
      const { item } = e.ask({
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
    preflight(def, at) {
      const needsCwd = def.stage.some((st) => (st.kind ?? "agent") === "agent" && !(st as { cwd?: string }).cwd);
      return needsCwd && !cfg().defaultCwd ? "Blueprints setting defaultCwd is not set: workers need a working directory. Set it in Factory > Blueprints > Settings." : null;
    },
    settings: () => ({ defaultCwd: cfg().defaultCwd, pmRole: cfg().pmRole, idleGraceSeconds: cfg().idleGraceSeconds, archiveOnFinish: cfg().archiveOnFinish, shareWorkspace: cfg().shareWorkspace, flakeRetries: cfg().flakeRetries ?? 3, runsMailTo: cfg().runs?.notifyMailTo ?? "", criteriaReminderMinutes: cfg().gates?.criteriaReminderMinutes ?? 30 }),
  };
  const engine = new Engine(store, ports);
  host.engines.blueprints = { engine, store, eventsMailTo: () => cfg().events.mailTo };
  host.issueSources.push(async () => {
    const out: { key: string; text: string }[] = [];
    const day = Date.now() - 24 * 3600_000;
    for (const run of store.all()) {
      const label = `${run.blueprint} ${run.vars.ticket || run.vars.incident_id || run.id}`;
      const finishedBad = run.status === "failed" && (run.endedAt ?? 0) > day;
      if (!(run.status === "paused" || finishedBad || (run.status === "waiting" && run.pm.pending))) continue;
      const hasPm = await engine.hasLivePm(run);
      if (hasPm && run.status !== "paused") continue; // a live PM is on it
      out.push({ key: `run:${run.id}:${run.status}`, text: `Run ${run.id} (${label}) is ${run.status} at stage ${run.stage ?? "?"}${hasPm ? "" : " with no live PM"}: ${run.error ?? run.waitingFor ?? "no detail"}` });
    }
    for (const e of catalog.errors) out.push({ key: `bp-file:${e.file}`, text: `Blueprint file ${path.basename(e.file)} does not load: ${e.message}` });
    return out;
  });

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
    runs({ since, hasVar }) {
      return store
        .all()
        .filter((r) => r.updatedAt >= since && (!hasVar || !!r.vars[hasVar]?.trim()))
        .map((r) => ({
          id: r.id,
          blueprint: r.blueprint,
          status: r.status,
          parent: r.parent,
          vars: r.vars,
          updatedAt: r.updatedAt,
          endedAt: r.endedAt,
          stages: Object.fromEntries(
            Object.entries(r.stages).map(([id, st]) => [id, { status: st.status, verdict: st.verdict, summary: st.summary, data: st.data }]),
          ),
          events: [...new Set(r.history.map((h) => h.event))],
        }));
    },
  };

  /** Usage of a turn of an agent the Factory spawned (Paseo reports lastUsage per turn). */
  async function recordSpend(agentId: string, turnId: string | null): Promise<void> {
    try {
      const labels = await host.labelsOf(agentId);
      if (labels["paseo.factory"] !== "1") return;
      const found = await agentRef(agentId).refresh();
      const usage = found?.agent.lastUsage;
      if (!usage) return;
      spend.add({
        agentId,
        turnId: turnId ?? `t${Date.now()}`,
        at: Date.now(),
        role: labels["paseo.factory.role"] ?? null,
        run: labels["paseo.factory.run"] ?? null,
        blueprint: labels["paseo.factory.blueprint"] ?? null,
        stage: labels["paseo.factory.stage"] ?? null,
        inputTokens: usage.inputTokens ?? 0,
        cachedInputTokens: usage.cachedInputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        costUsd: usage.totalCostUsd ?? 0,
      });
    } catch (error) {
      console.error("blueprints: spend record failed", error);
    }
  }

  // ---- events ----
  const removers = [
    host.on("blueprints", "agent.archived", ({ agent }) => {
      if (!cfg().archiveWorkspaceWithAgent) return;
      void archiveWorkspaceWithAgent(
        {
          workspaceOf: (id) => store.all().find((run) => run.agents?.[id])?.agents?.[id]?.workspaceId ?? null,
          liveAgentsIn,
          trace: (workspaceId) => statusTrace(host.paseo, workspaceId),
          archiveWorkspace: ports.archiveWorkspace!,
          log: (line) => console.log(line),
        },
        agent.id,
      ).catch((e) => console.error("blueprints: archive workspace failed", e));
    }),
    host.on("blueprints", "agent.turn_ended", ({ agent, outcome, turnId }) => {
      void retitleFactoryWorkspaces(host.paseo, runVars, agent.id);
      void recordSpend(agent.id, turnId).finally(() => engine.observer.retroEnded?.(agent.id));
      void engine.turnEnded(agent.id, { kind: outcome.kind, message: outcome.kind === "failed" ? outcome.error.message : undefined }).catch((e) => console.error("blueprints: turn_ended failed", e));
    }),
  ];
  const runVars = (id: string) => {
    const run = store.get(id);
    return run ? { vars: run.vars, blueprint: run.blueprint } : undefined;
  };
  host.whenPaseo((paseo) => void retitleFactoryWorkspaces(paseo, runVars));
  const unlisten = host.engines.inbox?.onResolved((item: { id: string; agentId: string }) => {
    if (item.agentId.startsWith("blueprint:")) void engine.gateResolved(item.id).catch((e) => console.error("blueprints: gate failed", e));
  });
  host.whenPaseo(() => void ready.then(() => engine.resumeAll()).catch((e) => console.error("blueprints: resume failed", e)));

  // One mail per new attention point to the events address (human decision f45ab3ba).
  const attention = new AttentionNotifier((process.env.BLUEPRINTS_STATE ?? host.statePath("blueprints")).replace(/blueprints\.json$/, "attention.json"), (p) =>
    host.report(cfg().events.mailTo, { subject: p.subject, body: p.body, kind: "info" }),
  );
  const notify = async () => {
    if (!cfg().events.mailTo?.trim() || store.suspended()) return;
    const pending = host.enabled("inbox") && host.engines.inbox ? (host.engines.inbox as import("../inbox/engine").Engine).store.pending() : [];
    await attention.tick(attentionPoints(store.all(), pending, Date.now()));
  };

  // The orphan sweep (every 5 minutes, human rule 2026-10-28): workers no live stage refers to, then agentless workspaces.
  let sweptAt = 0;
  let sweeping = false;
  const sweep = async () => {
    if (cfg().janitor.orphanSweep === false || store.suspended() || sweeping || spawning > 0 || Date.now() - sweptAt < ORPHAN_SWEEP_MS) return;
    sweeping = true;
    sweptAt = Date.now();
    try {
      const archived = await engine.sweepOrphans();
      const [{ entries: agents }, { entries: workspaces }] = await Promise.all([
        host.paseo.agents.list({ filter: { includeArchived: false, includeBackground: true } } as never) as unknown as Promise<{ entries: { agent: ListedAgent }[] }>,
        host.paseo.workspaces.list() as unknown as Promise<{ entries: ListedWorkspace[] }>,
      ]);
      const runs = store.all();
      const known = new Set(runs.flatMap((r) => Object.values(r.agents ?? {}).map((a) => a.workspaceId).filter((id): id is string => !!id)));
      // Forget the recorded workspaces that are gone (archived by the Factory, the spawn's clean-up or a person).
      const listed = new Set(workspaces.map((w) => w.id));
      store.forgetWorkspaces(Object.keys(store.createdWorkspaces()).filter((id) => !listed.has(id)));
      const created = new Map(Object.entries(store.createdWorkspaces()).map(([id, w]) => [id, w.at] as [string, number]));
      const found = agentlessWorkspaces(workspaces, agents.map((e) => e.agent), {
        known,
        created,
        titles: factoryWorkspaceTitles(runs, cfg().pmRole),
        now: Date.now(),
        pmAgentIds: new Set(runs.map((r) => r.pmAgentId).filter((id): id is string => !!id)),
        protect: new Set(runs.filter((r) => r.endedAt === null && r.sharedWorkspaceId).map((r) => r.sharedWorkspaceId!)),
      });
      for (const w of found) {
        const title = (w.title || w.name || "").trim();
        try {
          await ports.archiveWorkspace!(w.id);
        } catch (error) {
          console.error(`blueprints: orphan sweep could not archive workspace ${w.id}`, error);
          continue;
        }
        archived.push(w.id);
        const recorded = store.createdWorkspaces()[w.id]?.run;
        store.forgetWorkspaces([w.id]);
        const run = runs.find((r) => r.id === recorded) ?? runs.find((r) => Object.values(r.agents ?? {}).some((a) => a.workspaceId === w.id)) ?? runs.find((r) => r.vars.ticket && title.includes(r.vars.ticket));
        if (run) store.log(run, "orphan_archived", null, `workspace ${w.id} "${title}": no live agent`, Date.now());
        console.log(`blueprints: orphan sweep archived agentless workspace ${w.id} "${title}"`);
      }
      if (archived.length) {
        store.save();
        console.log(`blueprints: orphan sweep archived ${archived.length}: ${archived.join(", ")}`);
      }
    } finally {
      sweeping = false;
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const loop = async () => {
    try {
      if (host.enabled("blueprints")) void refresh().catch((e) => console.error("blueprints: catalog failed", e));
      if (host.enabled("blueprints") && host.hasPaseo()) await engine.tick();
      if (host.enabled("blueprints") && host.hasPaseo()) await notify();
      if (host.enabled("blueprints") && host.hasPaseo()) await sweep().catch((e) => console.error("blueprints: orphan sweep failed", e));
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
      blueprints: [...c.blueprints.values()].map((entry) => describe(entry)),
      errors: c.errors.map((e) => ({ file: path.basename(e.file), message: e.message })),
      settings: current,
      factorySuspended: store.suspended() ? { reason: store.suspended()!.reason, since: store.suspended()!.at, by: store.suspended()!.by } : null,
    };
  });
  server.handle(runDiffRpc, async ({ runId }, ctx) => {
    host.capture(ctx);
    const run = store.get(runId);
    const urls = new Set<string>();
    for (const st of Object.values(run?.stages ?? {})) if (Array.isArray(st.data.pr_urls)) for (const u of st.data.pr_urls) if (typeof u === "string") urls.add(u);
    const diff = host.overrides.prDiff ?? ghDiff;
    const prs = await Promise.all(
      [...urls].map(async (url) => {
        try {
          const d = await diff(url);
          return { url, filesUrl: `${url}/files`, files: d.files, additions: d.additions, deletions: d.deletions, error: null };
        } catch (error) {
          return { url, filesUrl: `${url}/files`, files: null, additions: null, deletions: null, error: (error as Error).message };
        }
      }),
    );
    return { prs };
  });
  server.handle(spendRpc, ({ days }, ctx) => {
    host.capture(ctx);
    return aggregate(spend.all(), Date.now() - days * 24 * 3600 * 1000);
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

  server.handle(suspendRunsRpc, async ({ runId, all, resume, reason }, ctx) => {
    host.capture(ctx);
    try {
      if (resume) {
        if (all) engine.resumeAllSuspended();
        else await engine.unsuspend(runId!);
      } else if (all) await engine.suspendAll({ reason: reason ?? "suspended from the Blueprints tab", by: "user" });
      else await engine.suspend(runId!, { reason: reason ?? "suspended from the Blueprints tab", by: "user" });
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
