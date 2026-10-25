import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { runViewSchema } from "./run";
import { settingsSchema } from "./settings";

export const listRunsRpc = defineRpc({
  name: "blueprints.list",
  input: z.object({ includeFinished: z.boolean().default(true) }),
  output: z.object({
    now: z.number(),
    runs: z.array(runViewSchema),
    blueprints: z.array(z.object({ name: z.string(), description: z.string(), vars: z.array(z.object({ name: z.string(), required: z.boolean(), description: z.string() })), stages: z.array(z.string()) })),
    errors: z.array(z.object({ file: z.string(), message: z.string() })),
    settings: settingsSchema.nullable(),
  }),
});

export const startRunRpc = defineRpc({
  name: "blueprints.start",
  input: z.object({ blueprint: z.string(), vars: z.record(z.string(), z.string()), at: z.string().optional() }),
  output: z.object({ ok: z.boolean(), runId: z.string().nullable(), message: z.string().nullable() }),
});

export const abortRunRpc = defineRpc({
  name: "blueprints.abort",
  input: z.object({ runId: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
});

export const retryRunRpc = defineRpc({
  name: "blueprints.resume",
  input: z.object({ runId: z.string(), stage: z.string().optional(), extraAttempts: z.number().int().min(0).max(20).default(1) }),
  output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
});
