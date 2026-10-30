import { z } from "zod";

/** Pseudo stages every `on` table may point at. */
export const TERMINALS = ["done", "failed"] as const;

const stageId = z.string().regex(/^[a-z][a-z0-9_-]*$/, "stage ids are lowercase letters, digits, '-' and '_'");
const target = z.string().min(1);

const varSchema = z.strictObject({
  description: z.string().default(""),
  required: z.boolean().default(false),
  default: z.string().optional(),
  pattern: z.string().optional(),
});

const optionSchema = z.strictObject({ id: z.string().min(1).max(64), label: z.string().min(1).max(200), description: z.string().max(500).optional(), recommended: z.boolean().optional() });

/** `on`: verdict -> next stage. `exhausted` takes "pm" (one judgement call), a stage id or "failed". */
const onSchema = z.record(z.string(), target);

const common = {
  id: stageId,
  title: z.string().optional(),
  /** Skip the stage when this renders true (`{{x}} == y`, `{{x}} != y`, or a bare `true`); the `skipped` edge is followed. */
  skip_if: z.string().optional(),
  /**
   * A stage id whose `data.pr_urls` is the run's PR set: on entry, when every one of those PRs is already merged on GitHub (read
   * fresh), the stage is not run and `on.already_merged` is followed (for example to the release). Nothing happens without PRs.
   */
  skip_if_merged: stageId.optional(),
  on: onSchema.default({}),
};

export const agentStageSchema = z.strictObject({
  ...common,
  kind: z.literal("agent").default("agent"),
  role: z.string().min(1),
  prompt: z.string().min(1),
  /** "new" starts a worker; "reuse:<stage>" sends the task to the worker of that stage (corrections go to the same implementer). */
  agent: z.string().regex(/^(new|reuse:[a-z][a-z0-9_-]*)$/).default("new"),
  /** Verdicts the worker may give. Defaults to the keys of `on` (minus the engine's own). */
  verdicts: z.array(z.string()).optional(),
  /** Tries per entry into the stage: a turn that ends without a verdict, or a failed turn, uses one. */
  max_attempts: z.number().int().min(1).default(1),
  /** Entries into the stage over the whole run (loops). */
  max_runs: z.number().int().min(1).default(50),
  /** Failed turns (provider or infrastructure errors) retried without using an attempt. */
  flake_retries: z.number().int().min(0).default(0),
  cwd: z.string().optional(),
  /**
   * "run": with the Blueprints setting `shareWorkspace` on, the worker joins the run's shared workspace (pod) instead of getting its own.
   * For the stages that own the code one after the other (investigate, implement, babysit); QA stays "new" for an independent checkout.
   */
  workspace: z.enum(["new", "run"]).default("new"),
  /** "pr": give the worker the GitHub facts of the PRs in `pr_urls_from`, and check its verdicts against them. */
  facts: z.enum(["pr"]).optional(),
  /** The stage whose `data.pr_urls` is the PR set. */
  pr_urls_from: stageId.optional(),
  /**
   * Seconds a freshly spawned worker's checkout has to answer git (`rev-parse` in its workspace). No answer, or not a worktree:
   * the worker and its workspace are archived and one fresh worker is started; a second failure pauses the run with the reason.
   */
  worktree_check: z.number().int().min(5).max(300).optional(),
  /** Verdict -> facts that must hold on GitHub (`ci_green`, `mergeable`, `open`) for the verdict to be accepted. */
  verify: z.record(z.string(), z.array(z.enum(["ci_green", "mergeable", "open", "exists"]))).optional(),
});

export const gateStageSchema = z.strictObject({
  ...common,
  kind: z.literal("gate"),
  question: z.string().min(1),
  context: z.string().optional(),
  options: z.array(optionSchema).optional(),
  free_text: z.boolean().default(false),
  /** Wording that the approval covers; hashed, and an identical earlier approval is reused. */
  criteria: z.string().optional(),
  /** Template resolving to the PR URLs (comma separated) this gate is tied to: withdrawn when a head moves, completed when merged. */
  pr: z.string().optional(),
  /** Free-text answer is stored in this variable (checked against the variable's pattern). */
  store_as: z.string().optional(),
  /** The answer text is added to the notes of this stage's worker prompt. */
  note_to: stageId.optional(),
  expires_in_minutes: z.number().min(1).optional(),
  /**
   * With `expires_in_minutes`: the answer (an option id) the gate takes by itself when nobody answered in time, instead of
   * following `on.expired`. The history says it was the default (decision c8125131: ask-blocked waited for days).
   */
  default_answer: z.string().min(1).optional(),
  /** An answer with the option id "hold" asks the same question again after this many minutes. */
  hold_minutes: z.number().min(1).optional(),
  /** The run's on-demand PM is spawned when the gate opens and may answer it (and only it); the human can still answer it in the Inbox. */
  pm: z.boolean().default(false),
  /**
   * "merge": a passive wait, no Inbox item. The gate completes with `on.merged` when every PR in `pr` is merged on GitHub (`on.head_moved` if a head moves first)
   * and with `on.expired` after `expires_in_minutes` (the engine's own timer, not an Inbox expiry). Someone merging is announced by the run's "waiting" mail.
   */
  wait: z.literal("merge").optional(),
  /**
   * With `wait = "merge"`: after this many minutes, a PR that is still open but neither in a merge queue nor tested (no CI run on
   * its head) will not merge by itself: the gate follows `on.stalled` (for example back to the stage that dispatches CI) instead
   * of waiting for `expires_in_minutes`.
   */
  stall_minutes: z.number().min(1).optional(),
});

export const callStageSchema = z.strictObject({
  ...common,
  kind: z.literal("call"),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  /** Role of the short-lived worker that makes the call when the tool is not one of the Factory's own. */
  role: z.string().optional(),
});

export const blueprintStageSchema = z.strictObject({
  ...common,
  kind: z.literal("blueprint"),
  blueprint: z.string().min(1),
  at: stageId.optional(),
  vars: z.record(z.string(), z.string()).default({}),
});

/** A stage kind an extension provides. Everything but the common fields is passed to it as params. */
export const extensionStageSchema = z.looseObject({
  ...common,
  kind: z.string().min(1),
});

export type AgentStage = z.output<typeof agentStageSchema>;
export type GateStage = z.output<typeof gateStageSchema>;
export type CallStage = z.output<typeof callStageSchema>;
export type BlueprintStage = z.output<typeof blueprintStageSchema>;
export type ExtensionStage = z.output<typeof extensionStageSchema>;
export type Stage = AgentStage | GateStage | CallStage | BlueprintStage | ExtensionStage;


function parseStage(raw: unknown): Stage {
  const kind = (raw as { kind?: string } | null)?.kind ?? "agent";
  switch (kind) {
    case "agent":
      return agentStageSchema.parse(raw);
    case "gate":
      return gateStageSchema.parse(raw);
    case "call":
      return callStageSchema.parse(raw);
    case "blueprint":
      return blueprintStageSchema.parse(raw);
    default:
      return extensionStageSchema.parse(raw);
  }
}

export const blueprintSchema = z
  .strictObject({
    version: z.literal(1).default(1),
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/, "blueprint names are lowercase letters, digits, '-' and '_'"),
    description: z.string().default(""),
    /** First stage; `blueprint_start(at=...)` may enter elsewhere. Defaults to the first stage listed. */
    start: stageId.optional(),
    /** Variables whose value a person or the PM must have checked for real (such as a ticket key); needs `<name>_confirmed = "true"` at start. */
    confirm: z.array(z.string()).default([]),
    /** Failed-run cap on the PM's single judgement call: at most this many extra attempts. */
    pm_extra_max: z.number().int().min(0).max(10).default(2),
    /** Most runs of this blueprint active at once (pods are a quota); more wait as "queued" and start, oldest first, when one ends. */
    max_active: z.number().int().min(1).optional(),
    vars: z.record(z.string(), varSchema).default({}),
    stage: z.array(z.unknown()).min(1),
  })
  .transform((b, ctx) => {
    const stages: Stage[] = [];
    b.stage.forEach((raw, i) => {
      try {
        stages.push(parseStage(raw));
      } catch (error) {
        if (error instanceof z.ZodError) {
          for (const issue of error.issues) ctx.addIssue({ code: "custom", path: ["stage", i, ...issue.path], message: issue.message });
        } else throw error;
      }
    });
    return { ...b, stage: stages };
  })
  .superRefine((b, ctx) => {
    const ids = new Set<string>();
    for (const [i, s] of b.stage.entries()) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["stage", i, "id"], message: `duplicate stage id ${s.id}` });
      ids.add(s.id);
    }
    const known = (t: string) => ids.has(t) || (TERMINALS as readonly string[]).includes(t);
    if (b.start && !ids.has(b.start)) ctx.addIssue({ code: "custom", path: ["start"], message: `start stage ${b.start} does not exist` });
    for (const [i, s] of b.stage.entries()) {
      for (const [verdict, next] of Object.entries(s.on)) {
        const ok = verdict === "exhausted" ? next === "pm" || known(next) : known(next);
        if (!ok) ctx.addIssue({ code: "custom", path: ["stage", i, "on", verdict], message: `unknown target "${next}"` });
      }
      if (s.kind === "gate") {
        const g = s as GateStage;
        if (g.note_to && !ids.has(g.note_to)) ctx.addIssue({ code: "custom", path: ["stage", i, "note_to"], message: `unknown stage ${g.note_to}` });
        if (g.store_as && !(g.store_as in b.vars)) ctx.addIssue({ code: "custom", path: ["stage", i, "store_as"], message: `unknown variable ${g.store_as}` });
        if (g.wait) {
          if (!g.pr) ctx.addIssue({ code: "custom", path: ["stage", i, "wait"], message: "a gate that waits for a merge needs pr" });
          if (!g.expires_in_minutes) ctx.addIssue({ code: "custom", path: ["stage", i, "expires_in_minutes"], message: "a gate that waits for a merge needs expires_in_minutes (its timeout)" });
          for (const edge of ["merged", "expired"]) if (!(edge in g.on)) ctx.addIssue({ code: "custom", path: ["stage", i, "on"], message: `a gate that waits for a merge needs an on.${edge} edge` });
        }
        if (g.default_answer) {
          if (!g.expires_in_minutes) ctx.addIssue({ code: "custom", path: ["stage", i, "default_answer"], message: "default_answer needs expires_in_minutes" });
          if (g.wait) ctx.addIssue({ code: "custom", path: ["stage", i, "default_answer"], message: "a merge wait has no answer to default to" });
          if (!(g.default_answer in g.on) && !("default" in g.on)) ctx.addIssue({ code: "custom", path: ["stage", i, "default_answer"], message: `default_answer ${g.default_answer} has no edge (on.${g.default_answer} or on.default)` });
        }
        if (g.pr && !("head_moved" in g.on)) ctx.addIssue({ code: "custom", path: ["stage", i, "on"], message: "a gate tied to PRs needs an on.head_moved edge" });
      }
      if (s.skip_if_merged && !("already_merged" in s.on)) ctx.addIssue({ code: "custom", path: ["stage", i, "on"], message: "a stage with skip_if_merged needs an on.already_merged edge" });
      if (s.skip_if_merged && !ids.has(s.skip_if_merged)) ctx.addIssue({ code: "custom", path: ["stage", i, "skip_if_merged"], message: `unknown stage ${s.skip_if_merged}` });
      if (s.skip_if && !("skipped" in s.on)) ctx.addIssue({ code: "custom", path: ["stage", i, "on"], message: "a stage with skip_if needs an on.skipped edge" });
      if (s.kind === "agent" || s.kind === undefined) {
        const a = s as AgentStage;
        const reuse = /^reuse:(.+)$/.exec(a.agent)?.[1];
        if (reuse && !ids.has(reuse)) ctx.addIssue({ code: "custom", path: ["stage", i, "agent"], message: `reuse of unknown stage ${reuse}` });
        const verdicts = a.verdicts ?? Object.keys(a.on).filter((k) => !RESERVED_ON.includes(k));
        if (verdicts.length === 0) ctx.addIssue({ code: "custom", path: ["stage", i, "on"], message: "an agent stage needs at least one verdict" });
        for (const v of verdicts) if (!(v in a.on)) ctx.addIssue({ code: "custom", path: ["stage", i, "on", v], message: `verdict ${v} has no next stage` });
      }
    }
    for (const name of b.confirm) if (!(name in b.vars)) ctx.addIssue({ code: "custom", path: ["confirm"], message: `confirm names unknown variable ${name}` });
  });

export type Blueprint = z.output<typeof blueprintSchema>;

/** `on` keys the engine fires itself, which are not verdicts a worker gives. */
export const RESERVED_ON = ["exhausted", "failed", "head_moved", "skipped", "already_merged"];

export function stageVerdicts(stage: Stage): string[] {
  if ((stage.kind ?? "agent") !== "agent") return Object.keys(stage.on);
  return (stage as AgentStage).verdicts ?? Object.keys(stage.on).filter((k) => !RESERVED_ON.includes(k));
}
