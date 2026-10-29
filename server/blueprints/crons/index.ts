// Cron schedules of the Blueprints module: schedules from the git sources and the settings, started through the engine.
import path from "node:path";
import type { FactoryHost } from "../../host";
import { NotFoundError, type Engine } from "../engine";
import type { RunStore } from "../store";
import type { BlueprintsSettings } from "../../../shared/blueprints/settings";
import { listCronsRpc, pauseCronRpc, resumeCronRpc, runCronNowRpc, type CronScheduleView } from "../../../shared/blueprints/crons";
import { isoMinute, nextMatch } from "./cron";
import { Scheduler, StateFile, isActive, type Ports, type StartResult } from "./scheduler";
import { loadSchedules, SCHEDULES_FILE, type Parsed } from "./schedules";

/** Starts the engine refuses for good (a missing blueprint, stage or var); anything else (a suspended Factory...) is retried. */
const REFUSED = /No blueprint "|has no stage "|Variable \S+ (is required|must match)|Unknown variable|must be confirmed/;

export function engineStart(engine: Engine, input: Parameters<Ports["start"]>[0]): StartResult {
  try {
    return { ok: true, runId: engine.start(input).id };
  } catch (error) {
    const message = (error as Error).message;
    return { ok: false, retry: !(error instanceof NotFoundError || REFUSED.test(message)), error: message };
  }
}

interface Deps {
  host: FactoryHost;
  engine: Engine;
  store: RunStore;
  cfg: () => BlueprintsSettings;
  /** The catalog is loaded and has blueprints (no start before, so a cold start does not count as refusals). */
  catalogReady: () => Promise<boolean>;
  stateFile: string | null;
  /** Resolves once the settings were read. */
  ready: Promise<unknown>;
}

export function startCrons({ host, engine, store, cfg, catalogReady, stateFile, ready }: Deps) {
  const log = (line: string) => console.log(`blueprints: cron ${line}`);
  const scheduler = new Scheduler(new StateFile(stateFile), {
    runs: () => store.all().filter((r) => !!r.vars.cron_id?.trim()).map((r) => ({ id: r.id, status: r.status, vars: r.vars })),
    start: (input) => engineStart(engine, input),
    async mail(m) {
      try {
        await host.report(m.to, { subject: m.subject, body: m.body, kind: "notice" });
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    },
    log,
  });

  const lastGood = new Map<string, unknown[]>();
  let parsed: Parsed = { schedules: [], errors: [] };
  let lastErrors = "";
  async function load(): Promise<Parsed> {
    const files: { file: string; label: string }[] = [];
    for (const source of (await host.configuredSources()) as { url: string; ref?: string; path?: string }[]) {
      if (!host.gitSources) continue;
      const label = `${source.url.replace(/^.*[:/]([^/:]+\/[^/]+?)(\.git)?$/, "$1")}@${source.ref ?? "default"}:${source.path ? `${source.path}/` : ""}${SCHEDULES_FILE}`;
      files.push({ file: path.join(host.gitSources.subDir(source, ""), SCHEDULES_FILE), label });
    }
    parsed = await loadSchedules(files, cfg().crons?.schedules ?? [], lastGood);
    const errs = parsed.errors.join("; ");
    if (errs && errs !== lastErrors) console.error(`blueprints: cron schedules left out: ${errs}`);
    lastErrors = errs;
    return parsed;
  }

  /** One scheduler tick, when crons are on and the catalog is there. */
  async function tick(now = Date.now()): Promise<void> {
    await ready;
    if (!cfg().crons?.enabled) return;
    await load();
    if (!(await catalogReady())) return;
    await scheduler.tick(parsed.schedules, now, cfg().crons.mailTo);
  }

  host.issueSources.push(() => {
    const out = parsed.errors.map((e) => ({ key: `cron-file:${e.split(":")[0]}`, text: `Cron schedule left out: ${e}` }));
    if (cfg().crons?.enabled) {
      for (const s of parsed.schedules) {
        const st = scheduler.snapshot().schedules[s.id];
        if (st?.paused && st.pausedBy === "failures") out.push({ key: `cron:${s.id}:paused`, text: `Cron ${s.id} (blueprint ${s.blueprint}) is paused after ${st.consecutiveFailures} failed runs in a row; resume it in the Crons tab.` });
      }
    }
    return out;
  });

  const find = async (id: string) => (await ready, await load()).schedules.find((s) => s.id === id) ?? null;

  host.server.handle(listCronsRpc, async (_input, ctx) => {
    host.capture(ctx);
    await ready;
    const now = Date.now();
    const on = !!cfg().crons?.enabled;
    await load();
    const runs = store.all();
    const schedules = parsed.schedules.map((s): CronScheduleView => {
      const st = scheduler.snapshot().schedules[s.id];
      const active = runs.find((r) => r.vars.cron_id === s.id && isActive(r));
      const last = st?.lastRunId ? store.get(st.lastRunId) : undefined;
      const paused = st?.paused ?? false;
      return {
        id: s.id,
        cron: s.cron,
        timezone: s.timezone,
        blueprint: s.blueprint,
        source: s.source,
        enabled: s.enabled,
        paused,
        pausedAt: st?.pausedAt ?? null,
        consecutiveFailures: st?.consecutiveFailures ?? 0,
        maxFailures: s.maxFailures,
        nextRunAt: on && s.enabled && !paused ? nextMatch(s.parsed, s.timezone, now) : null,
        activeRun: active ? { id: active.id, status: active.status } : null,
        lastRunId: st?.lastRunId ?? null,
        lastResult: last ? last.status : (st?.lastResult ?? null),
        lastSlot: st?.lastSlot != null ? isoMinute(st.lastSlot) : null,
      };
    });
    return { now, enabled: on, schedules, errors: parsed.errors };
  });
  host.server.handle(pauseCronRpc, async ({ id }, ctx) => {
    host.capture(ctx);
    if (!(await find(id))) return { ok: false, message: `No cron schedule "${id}".` };
    scheduler.pause(id, Date.now());
    return { ok: true, message: `${id} paused` };
  });
  host.server.handle(resumeCronRpc, async ({ id }, ctx) => {
    host.capture(ctx);
    if (!(await find(id))) return { ok: false, message: `No cron schedule "${id}".` };
    scheduler.resume(id, "from the Crons tab");
    return { ok: true, message: `${id} resumed` };
  });
  host.server.handle(runCronNowRpc, async ({ id }, ctx) => {
    host.capture(ctx);
    const s = await find(id);
    if (!s) return { ok: false, runId: null, message: `No cron schedule "${id}".` };
    await catalogReady();
    return scheduler.runNow(s, Date.now());
  });

  return { tick, scheduler, load };
}
