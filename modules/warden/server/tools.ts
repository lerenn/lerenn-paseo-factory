import { z } from "zod";
import type { Engine } from "./engine";
import type { Task } from "./store";

export interface ToolContext {
  engine: Engine;
  /** The calling agent. */
  callerId: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodObject;
  run(input: any, ctx: ToolContext): Promise<unknown> | unknown;
}

export class UsageError extends Error {}

const interval = z
  .number()
  .min(1)
  .max(24 * 60)
  .optional()
  .describe(
    "Hang backstop in minutes (1 to 1440): how long a RUNNING agent may stay silent before a ping. Idle stops are caught within a minute regardless. " +
      "Values above the configured max (default 15) are clamped. Optional: defaults to PASEO_WARDEN_INTERVAL, else the max.",
  );

/** The explicit interval, else the agent's creation-time default, else a clear error. */
function intervalFor(explicit: number | undefined, agentId: string, ctx: ToolContext): number {
  return explicit ?? ctx.engine.store.agent(agentId)?.defaultIntervalMinutes ?? ctx.engine.defaultIntervalMinutes();
}
const until = z
  .string()
  .optional()
  .describe("ISO 8601 time after which the warden stops, e.g. 2026-10-24T09:00:00Z.");

function parseUntil(value: string | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new UsageError(`until must be an ISO 8601 time, got "${value}"`);
  if (at <= Date.now()) throw new UsageError("until is already in the past");
  return at;
}

function summary(task: Task, ctx: ToolContext) {
  return { task_id: task.id, agent_id: task.agentId, task: task.task, interval_minutes: task.intervalMinutes, status: ctx.engine.status(task) };
}

/** The caller may manage a task if it is the task's agent, registered it, or is an ancestor of the agent. */
function manageable(task: Task, ctx: ToolContext): boolean {
  const { callerId, engine } = ctx;
  return callerId === task.agentId || callerId === task.registeredBy || engine.store.isAncestor(callerId, task.agentId);
}

function find(taskId: string, ctx: ToolContext): Task {
  const task = ctx.engine.store.get(taskId);
  if (!task) throw new UsageError(`No warden task "${taskId}". Use warden_list to see yours.`);
  if (!manageable(task, ctx)) throw new UsageError(`Task ${taskId} belongs to agent ${task.agentId}; you did not register it and are not its parent.`);
  return task;
}

export const TOOLS: ToolDef[] = [
  {
    name: "warden_register",
    description:
      "Register a task you are working on or waiting for (a long build, a CI run, a subagent, a review). Warden will prompt you if " +
      "your turn ends without warden_done (pinged within about a minute) or you hang silently for interval_minutes while running. " +
      "interval_minutes only matters for hangs. Your parent is told if you stay silent. Returns task_id. Call warden_done when finished.",
    input: z.object({
      task: z.string().min(1).max(500).describe("What you are doing or waiting for."),
      interval_minutes: interval,
      until,
    }),
    run({ task, interval_minutes, until: u }, ctx) {
      const t = ctx.engine.register({
        agentId: ctx.callerId,
        task,
        intervalMinutes: intervalFor(interval_minutes, ctx.callerId, ctx),
        until: parseUntil(u),
        registeredBy: ctx.callerId,
        source: "agent",
      });
      return summary(t, ctx);
    },
  },
  {
    name: "warden_register_subagent",
    description:
      "Register a warden on one of your subagents (you must be its parent or an ancestor). Warden prompts that agent within a minute of its turn ending without warden_done, " +
      "or after interval_minutes of silence while it runs (hangs), and notifies you if it stays unresponsive.",
    input: z.object({
      agent_id: z.string().min(1).describe("The subagent to warden."),
      task: z.string().min(1).max(500).describe("What the subagent is expected to be doing."),
      interval_minutes: interval,
      until,
    }),
    run({ agent_id, task, interval_minutes, until: u }, ctx) {
      const { store } = ctx.engine;
      if (!store.isAncestor(ctx.callerId, agent_id)) {
        throw new UsageError(`${agent_id} is not your subagent (or warden has not seen it yet).`);
      }
      if (store.optedOut(agent_id)) throw new UsageError(`${agent_id} (or its parent) opted out of warden with PASEO_WARDEN=off.`);
      const t = ctx.engine.register({
        agentId: agent_id,
        task,
        intervalMinutes: intervalFor(interval_minutes, agent_id, ctx),
        until: parseUntil(u),
        registeredBy: ctx.callerId,
        source: "parent",
      });
      return summary(t, ctx);
    },
  },
  {
    name: "warden_update",
    description:
      "Record progress on a watched task. Counts as activity, so the quiet timer restarts. " +
      "Set waiting_on (e.g. \"CI on PR 12\") to mark that you, or a subagent of yours via agent_id, is waiting on something: " +
      "the supervising coordinator is not told the agent went idle until the mark is cleared (waiting_on empty) or the agent gets new input. " +
      "task_id is optional when only setting or clearing waiting_on.",
    input: z.object({
      task_id: z.string().optional(),
      note: z.string().min(1).max(1000).optional(),
      waiting_on: z.string().max(300).optional().describe("What the agent waits on. Empty string clears the mark."),
      agent_id: z.string().optional().describe("The agent to mark waiting; defaults to you. Must be you or a descendant."),
    }),
    run({ task_id, note, waiting_on, agent_id }, ctx) {
      if (!note && waiting_on === undefined) throw new UsageError("Give a note, waiting_on, or both.");
      const task = task_id ? find(task_id, ctx) : undefined;
      if (task && task.state !== "active") throw new UsageError(`Task ${task_id} is ${task.state}.`);
      if (waiting_on !== undefined) {
        const target = agent_id ?? task?.agentId ?? ctx.callerId;
        if (target !== ctx.callerId && !ctx.engine.store.isAncestor(ctx.callerId, target)) {
          throw new UsageError(`${target} is not you or your subagent (or warden has not seen it yet).`);
        }
        ctx.engine.setWaiting(target, waiting_on.trim() || null);
      }
      if (task && note) ctx.engine.note(task, note);
      else if (task) ctx.engine.activity(task.agentId);
      return task ? summary(task, ctx) : { waiting_on: waiting_on?.trim() || null };
    },
  },
  {
    name: "warden_done",
    description: "Finish a watched task with its result. Warden stops watching it.",
    input: z.object({ task_id: z.string(), result: z.string().max(2000) }),
    run({ task_id, result }, ctx) {
      const task = find(task_id, ctx);
      if (task.state === "active") ctx.engine.finish(task, "done", result);
      return summary(task, ctx);
    },
  },
  {
    name: "warden_list",
    description: "List active warden tasks you registered, or that warden your subagents.",
    input: z.object({}),
    run(_input, ctx) {
      return ctx.engine.store
        .active()
        .filter((t) => manageable(t, ctx))
        .map((t) => summary(t, ctx));
    },
  },
];

/** Deprecated `warder_*` aliases of the tools, still callable by agents that were injected before the rename. */
export const LEGACY_TOOLS: ToolDef[] = TOOLS.map((t) => ({
  ...t,
  name: t.name.replace("warden_", "warder_"),
  description: `Deprecated alias of ${t.name}. ${t.description}`,
}));
