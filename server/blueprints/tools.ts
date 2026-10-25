import { z } from "zod";
import type { CallContext, HostTool } from "../tools";
import { UsageError } from "../tools";
import { stageVerdicts } from "../../shared/blueprints/blueprint";
import type { Engine } from "./engine";
import type { Loaded } from "./toml";

export interface Deps {
  engine: Engine;
  catalog(): Promise<Map<string, Loaded>>;
}

export const INSTRUCTIONS = `Blueprints are the Factory's flows: a run walks the stages of a blueprint, each stage names a role, and the verdict a worker gives picks the next stage.

If you are a stage worker (your prompt says "You are stage ..."): do the work, then call blueprint_verdict(run, stage, verdict, summary, data) and stop. Never end your turn without it. Facts about pull requests are checked on GitHub, not taken from your word.

If you are the PM: blueprint_list shows what you can run, blueprint_start(blueprint, vars, at?) starts a run (code changes need a Linear key you checked: pass ticket_confirmed="true"), blueprint_status follows it. When a stage is exhausted you get ONE judgement call: blueprint_retry grants a few extra attempts or re-scopes; to escalate ask the human with inbox_ask, then blueprint_resume or blueprint_abort. blueprint_retry, blueprint_resume and blueprint_abort are for the run's PM and the Assistant only.`;

const runArg = z.string().describe("Run id (bp-...).");

export function blueprintTools(deps: Deps): Omit<HostTool, "owner">[] {
  const { engine } = deps;

  /** The PM of the run (or whoever started it) and the Assistant may steer it. */
  async function steer(run: ReturnType<Engine["require"]>, ctx: CallContext): Promise<void> {
    if (ctx.callerId === run.pmAgentId || ctx.callerId === run.ownerAgentId || ctx.callerId === "factory") return;
    if (!(await engine.hasLivePm(run))) return; // no PM to protect: anyone may steer
    const labels = await ctx.labels();
    if (labels["paseo.assistant"] === "1" || labels["paseo.factory.supervisor"] === "1") return;
    throw new UsageError(`Run ${run.id} is steered by its PM (${run.pmAgentId ?? "none"}) and the Assistant.`);
  }

  return [
    {
      name: "blueprint_list",
      description: "The blueprints you can start, with their variables and stages.",
      input: z.object({}),
      async run() {
        const catalog = await deps.catalog();
        return [...catalog.values()].map(({ blueprint }) => ({
          name: blueprint.name,
          description: blueprint.description,
          vars: Object.entries(blueprint.vars).map(([name, v]) => ({ name, required: v.required, description: v.description, ...(blueprint.confirm.includes(name) ? { needs: `${name}_confirmed=true` } : {}) })),
          stages: blueprint.stage.map((s) => s.id),
        }));
      },
    },
    {
      name: "blueprint_start",
      description:
        "Start a run of a blueprint. vars are strings. Variables that change code (the Linear ticket) must be checked for real first and passed with <name>_confirmed=\"true\". " +
        "`at` enters at a later stage (for example a ticket run at implement). Returns the run id; you are the run's PM and are told when it finishes or needs you.",
      input: z.object({
        blueprint: z.string(),
        vars: z.record(z.string(), z.string()).default({}),
        at: z.string().optional(),
        idempotency_key: z.string().max(200).optional(),
      }),
      async run({ blueprint, vars, at, idempotency_key }, ctx) {
        await deps.catalog();
        const run = engine.start({ blueprint, vars, at, requestedBy: ctx.callerId, ownerAgentId: ctx.callerId, idempotencyKey: idempotency_key });
        return { run_id: run.id, stage: run.stage, status: run.status };
      },
    },
    {
      name: "blueprint_status",
      description: "One run's card (stages, attempts, history), or all active runs when no run is given.",
      input: z.object({ run: runArg.optional(), include_finished: z.boolean().optional() }),
      run({ run, include_finished }) {
        if (run) return engine.view(engine.require(run));
        return engine.store
          .all()
          .filter((r) => include_finished || r.endedAt === null)
          .map((r) => ({ run_id: r.id, blueprint: r.blueprint, status: r.status, stage: r.stage, waiting_for: r.waitingFor, vars: r.vars }));
      },
    },
    {
      name: "blueprint_verdict",
      description:
        "Give the verdict of your stage; it picks the next stage. For a stage that produced pull requests, put them in data.pr_urls (checked on GitHub). Call it once, then stop.",
      input: z.object({
        run: runArg.optional().describe("Defaults to the run you work for."),
        stage: z.string().optional(),
        verdict: z.string(),
        summary: z.string().max(4000).optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
      async run(input, ctx) {
        const out = await engine.verdict(ctx.callerId, input);
        return { accepted: true, next: out.next };
      },
    },
    {
      name: "blueprint_retry",
      description:
        "The PM's ONE judgement call on an exhausted stage: grant extra_attempts (1 to the blueprint's pm_extra_max, default 2) with an optional note for the worker, or re-scope with to=<stage> and a note. A second exhaustion fails the run and escalates to the human.",
      input: z.object({ run: runArg, stage: z.string().optional(), extra_attempts: z.number().int().min(1).optional(), to: z.string().optional(), note: z.string().max(2000).optional() }),
      async run({ run, stage, extra_attempts, to, note }, ctx) {
        await steer(engine.require(run), ctx);
        const out = await engine.retry(run, { stage, extraAttempts: extra_attempts, to, note });
        return { run_id: out.id, status: out.status, stage: out.stage };
      },
    },
    {
      name: "blueprint_resume",
      description: "Continue a failed, paused or PM-waiting run at a stage after a person decided; extra_attempts adds attempts beyond the caps.",
      input: z.object({ run: runArg, stage: z.string().optional(), extra_attempts: z.number().int().min(0).max(20).optional(), note: z.string().max(2000).optional() }),
      async run({ run, stage, extra_attempts, note }, ctx) {
        await steer(engine.require(run), ctx);
        const out = await engine.resume(run, { stage, extraAttempts: extra_attempts, note });
        return { run_id: out.id, status: out.status, stage: out.stage };
      },
    },
    {
      name: "blueprint_abort",
      description: "Stop a run for good. Its workers keep their work; open gates are withdrawn.",
      input: z.object({ run: runArg, reason: z.string().max(1000).default("aborted") }),
      async run({ run, reason }, ctx) {
        await steer(engine.require(run), ctx);
        const out = await engine.abort(run, reason);
        return { run_id: out.id, status: out.status };
      },
    },
  ];
}

export const TOOL_NAMES = ["blueprint_list", "blueprint_start", "blueprint_status", "blueprint_verdict", "blueprint_retry", "blueprint_abort", "blueprint_resume"];
/** What a stage worker needs. */
export const WORKER_TOOL_NAMES = ["blueprint_verdict", "blueprint_status"];

export { stageVerdicts };
