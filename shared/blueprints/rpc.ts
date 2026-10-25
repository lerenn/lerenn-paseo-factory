import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { runViewSchema } from "./run";
import { settingsSchema } from "./settings";

export const stageDetailSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string().nullable(),
  role: z.string().nullable(),
  /** "new", "reuse:<stage>" or null for non-agent stages. */
  agent: z.string().nullable(),
  verdicts: z.array(z.string()),
  on: z.record(z.string(), z.string()),
  maxAttempts: z.number().nullable(),
  maxRuns: z.number().nullable(),
  flakeRetries: z.number().nullable(),
  skipIf: z.string().nullable(),
  facts: z.string().nullable(),
  verify: z.record(z.string(), z.array(z.string())),
  /** gate stages */
  gate: z.object({ question: z.string(), pr: z.string().nullable(), criteria: z.boolean(), freeText: z.boolean(), storeAs: z.string().nullable(), noteTo: z.string().nullable() }).nullable(),
  tool: z.string().nullable(),
  childBlueprint: z.string().nullable(),
  usesLease: z.boolean(),
});
export type StageDetail = z.infer<typeof stageDetailSchema>;

export const blueprintInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  vars: z.array(z.object({ name: z.string(), required: z.boolean(), description: z.string() })),
  stages: z.array(z.string()),
  /** git source label ("url@ref") or folder */
  source: z.string(),
  pmExtraMax: z.number(),
  confirm: z.array(z.string()),
  details: z.array(stageDetailSchema),
  text: z.string(),
});
export type BlueprintInfo = z.infer<typeof blueprintInfoSchema>;

export const listRunsRpc = defineRpc({
  name: "blueprints.list",
  input: z.object({ includeFinished: z.boolean().default(true) }),
  output: z.object({
    now: z.number(),
    runs: z.array(runViewSchema),
    blueprints: z.array(blueprintInfoSchema),
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

const totals = { turns: z.number(), inputTokens: z.number(), cachedInputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() };
export const spendRpc = defineRpc({
  name: "blueprints.spend",
  input: z.object({ days: z.number().int().min(1).max(365).default(30) }),
  output: z.object({
    total: z.object(totals),
    byRun: z.array(z.object({ key: z.string(), blueprint: z.string().nullable(), ...totals })),
    byRole: z.array(z.object({ key: z.string(), ...totals })),
    byDay: z.array(z.object({ key: z.string(), ...totals })),
  }),
});

/** PRs of a run with their diff summary, read from GitHub. */
export const runDiffRpc = defineRpc({
  name: "blueprints.diff",
  input: z.object({ runId: z.string() }),
  output: z.object({
    prs: z.array(z.object({ url: z.string(), filesUrl: z.string(), files: z.number().nullable(), additions: z.number().nullable(), deletions: z.number().nullable(), error: z.string().nullable() })),
  }),
});
