import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsSchema = z.object({
  /** Folder new workers start in when a stage names none. */
  defaultCwd: z.string().optional(),
  /** Provider of workers; a role may replace it. */
  defaultProvider: z.string().default("claude"),
  /** Role of the PM agent the Factory spawns when a run has none to ask (stalls, judgement calls). */
  pmRole: z.string().default("pm"),
  /** How often PR gates are polled and idle workers checked. */
  pollSeconds: z.number().int().min(10).default(60),
  /** A worker idle this long without a verdict gets nudged. */
  idleGraceSeconds: z.number().int().min(10).default(90),
  /** Archive the workers of a finished run. */
  archiveOnFinish: z.boolean().default(false),
});
export type BlueprintsSettings = z.output<typeof settingsSchema>;

export const blueprintsSettings = defineSettings({ id: "blueprints", scope: "host", version: 1, schema: settingsSchema });
