import { z } from "zod";

export const runStatusSchema = z.enum(["running", "waiting", "paused", "suspended", "done", "failed", "aborted"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const stageStatusSchema = z.enum(["pending", "entering", "running", "waiting", "done", "exhausted", "skipped", "failed"]);

export const stageViewSchema = z.object({
  id: z.string(),
  kind: z.string(),
  role: z.string().nullable(),
  status: stageStatusSchema,
  runs: z.number(),
  attempts: z.number(),
  maxAttempts: z.number().nullable(),
  maxRuns: z.number().nullable(),
  agentId: z.string().nullable(),
  verdict: z.string().nullable(),
  summary: z.string().nullable(),
});
export type StageView = z.infer<typeof stageViewSchema>;

/** One card per run. */
export const runViewSchema = z.object({
  id: z.string(),
  blueprint: z.string(),
  status: runStatusSchema,
  stage: z.string().nullable(),
  vars: z.record(z.string(), z.string()),
  /** What the run is called: the blueprint's `label` rendered, else ticket, else incident_id, else the run id. */
  label: z.string(),
  requestedBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().nullable(),
  error: z.string().nullable(),
  waitingFor: z.string().nullable(),
  /** Set while the run is suspended (see blueprint_suspend). */
  suspended: z
    .object({
      reason: z.string(),
      since: z.number(),
      by: z.string(),
      pods: z.array(z.string()),
      /** Held for a provider usage limit ("paused: quota"): when it resumes (null: with the Factory, or by a probe). */
      quota: z.object({ source: z.enum(["own", "global"]), rule: z.string().nullable(), resumeAt: z.number().nullable() }).nullable().optional(),
    })
    .nullable(),
  pmPending: z.object({ stage: z.string(), reason: z.string() }).nullable(),
  /** Open inbox items escalating this run to the human (stuck or setup); the sidebar badge counts those items, not the run. */
  escalations: z.array(z.string()).default([]),
  parent: z.object({ runId: z.string(), stageId: z.string() }).nullable(),
  stages: z.array(stageViewSchema),
  history: z.array(z.object({ at: z.number(), stage: z.string().nullable(), event: z.string(), detail: z.string().nullable() })).max(200),
});
export type RunView = z.infer<typeof runViewSchema>;
