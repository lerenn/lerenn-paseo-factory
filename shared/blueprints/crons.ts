import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * One cron schedule: start `blueprint` with `vars` whenever `cron` matches the wall clock of `timezone`. Entries come from
 * `crons/schedules.json` (`{"schedules": [...]}`) of each git source and from the Blueprints setting `crons.schedules`.
 */
export const scheduleEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "lowercase letters, digits, - and _"),
  /** 5 fields: minute hour day-of-month month day-of-week, with `*`, lists, ranges and steps. */
  cron: z.string().min(1),
  /** IANA time zone the cron is read in. */
  timezone: z.string().default("UTC"),
  blueprint: z.string().min(1),
  vars: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
  /** Failed or aborted runs in a row that pause the schedule. */
  maxFailures: z.number().int().min(1).default(2),
  /** Agents Mail address told when the schedule pauses; replaces the setting `crons.mailTo`. */
  mailTo: z.string().optional(),
});
export type ScheduleEntry = z.output<typeof scheduleEntrySchema>;

export const cronScheduleViewSchema = z.object({
  id: z.string(),
  cron: z.string(),
  timezone: z.string(),
  blueprint: z.string(),
  /** Where the entry comes from: a git source label or "settings". */
  source: z.string(),
  enabled: z.boolean(),
  paused: z.boolean(),
  pausedAt: z.number().nullable(),
  consecutiveFailures: z.number(),
  maxFailures: z.number(),
  /** The next minute it fires (epoch ms); null when crons are off, the schedule is disabled or paused. */
  nextRunAt: z.number().nullable(),
  activeRun: z.object({ id: z.string(), status: z.string() }).nullable(),
  lastRunId: z.string().nullable(),
  /** Status of the last run (live from the run store when it is still there), or "refused: ..." for a start refused. */
  lastResult: z.string().nullable(),
  /** The last slot handled (UTC ISO minute). */
  lastSlot: z.string().nullable(),
});
export type CronScheduleView = z.infer<typeof cronScheduleViewSchema>;

export const listCronsRpc = defineRpc({
  name: "blueprints.crons.list",
  input: z.object({}),
  output: z.object({
    now: z.number(),
    /** The Blueprints setting `crons.enabled`: off, nothing starts on its own (Run now still works). */
    enabled: z.boolean(),
    schedules: z.array(cronScheduleViewSchema),
    /** Schedules files or entries left out, with the reason. */
    errors: z.array(z.string()),
  }),
});

const result = z.object({ ok: z.boolean(), message: z.string().nullable() });
export const pauseCronRpc = defineRpc({ name: "blueprints.crons.pause", input: z.object({ id: z.string().min(1) }), output: result });
export const resumeCronRpc = defineRpc({ name: "blueprints.crons.resume", input: z.object({ id: z.string().min(1) }), output: result });
/** Starts the schedule's blueprint now, unless a run of it is still active. */
export const runCronNowRpc = defineRpc({
  name: "blueprints.crons.run_now",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), runId: z.string().nullable(), message: z.string().nullable() }),
});
