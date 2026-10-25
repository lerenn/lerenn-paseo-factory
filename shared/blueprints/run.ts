import { z } from "zod";

export const runStatusSchema = z.enum(["running", "waiting", "paused", "done", "failed", "aborted"]);
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
  requestedBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().nullable(),
  error: z.string().nullable(),
  waitingFor: z.string().nullable(),
  pmPending: z.object({ stage: z.string(), reason: z.string() }).nullable(),
  parent: z.object({ runId: z.string(), stageId: z.string() }).nullable(),
  stages: z.array(stageViewSchema),
  history: z.array(z.object({ at: z.number(), stage: z.string().nullable(), event: z.string(), detail: z.string().nullable() })).max(200),
});
export type RunView = z.infer<typeof runViewSchema>;
