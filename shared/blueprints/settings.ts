import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsSchema = z.object({
  /** Folder new workers start in when a stage names none. */
  defaultCwd: z.string().optional(),
  /** "provider/model" of workers; a role's own provider and model replace it. */
  defaultProvider: z.string().default("claude/claude-sonnet-5-5"),
  /** Role of the PM agent the Factory spawns when a run has none to ask (stalls, judgement calls). */
  pmRole: z.string().default("pm"),
  /** How often PR gates are polled and idle workers checked. */
  pollSeconds: z.number().int().min(10).default(60),
  /** A worker idle this long without a verdict gets nudged. */
  idleGraceSeconds: z.number().int().min(10).default(90),
  /** Archive the workers of a finished run. */
  archiveOnFinish: z.boolean().default(false),
  /** When an agent the Factory spawned is archived (by anyone), archive its workspace (pod) too, if it has no other live agent and its worktree is clean. */
  archiveWorkspaceWithAgent: z.boolean().default(true),
  /** Stages marked `workspace = "run"` share one workspace (pod) per run. Off: every worker gets its own, as before. */
  shareWorkspace: z.boolean().default(false),
  /** Infrastructure failures of a worker (exit 137/143, pod did not start, container not found, evicted...) retried per stage entry with a fresh pod, without using an attempt. A stage's own `flake_retries` raises it. */
  flakeRetries: z.number().int().min(0).default(3),
  /** Notices of a run that ended or needs a PM judgement. Empty: a message to the agent that started the run (as before). An address or alias (e.g. @assistant): one mail there instead, no live message. */
  runs: z.object({ notifyMailTo: z.string().default("") }).default({ notifyMailTo: "" }),
  /** Gates waiting for a person. */
  gates: z.object({ criteriaReminderMinutes: z.number().min(0).default(30) }).default({ criteriaReminderMinutes: 30 }),
  /** Mails to an agent when a run waits for a person or the PM, fails, is aborted or exhausts a stage. */
  events: z.object({ mailTo: z.string().default("@assistant") }).default({ mailTo: "@assistant" }),
  /**
   * Feedback in the Slack thread of a run started from a Slack message (vars `slack_channel`, `slack_thread_ts`): 👀, the diagnosis,
   * the PR links, ✅ on merge. Only `channels` listed here; the bot token is read from `tokenFile` (a mounted Kubernetes Secret).
   */
  slack: z
    .object({
      channels: z.array(z.string().regex(/^[CG][A-Z0-9]{6,}$/)).default([]),
      tokenFile: z.string().default("/etc/paseo/secrets/slack-factory-bot/token"),
    })
    .default({ channels: [], tokenFile: "/etc/paseo/secrets/slack-factory-bot/token" }),
  /** After a run ends (done, failed or aborted), a small separate agent mails one short retrospective. */
  retro: z
    .object({
      enabled: z.boolean().default(true),
      mailTo: z.string().default("@user"),
      role: z.string().default("retro"),
      /** Spend above this is flagged in the run history (a turn cannot be cut short). */
      maxUsd: z.number().min(0).default(0.3),
      /** The retro agent is given up on (and archived) after this long. */
      timeoutMinutes: z.number().min(1).default(10),
      /** A run that went through without a retry gets a three-line mail instead of an agent. */
      skipTrivial: z.boolean().default(true),
    })
    .default({ enabled: true, mailTo: "@user", role: "retro", maxUsd: 0.3, timeoutMinutes: 10, skipTrivial: true }),
  /** After the retro, archive the run's workers and their workspaces, except worktrees with uncommitted or unpushed work. */
  janitor: z
    .object({
      enabled: z.boolean().default(false),
      /** Plan and report what would be archived, archive nothing. */
      dryRun: z.boolean().default(true),
      /** Every 10 minutes, archive workers no stage of an active run refers to, and agentless Factory workspaces. Off: the kill switch. */
      orphanSweep: z.boolean().default(true),
    })
    .default({ enabled: false, dryRun: true, orphanSweep: true }),
});
export type BlueprintsSettings = z.output<typeof settingsSchema>;

export const blueprintsSettings = defineSettings({ id: "blueprints", scope: "host", version: 1, schema: settingsSchema });
