import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsSchema = z.object({
  /** Start the Supervisor agent when the plugin starts and bring it back when it dies. */
  autoStart: z.boolean().default(true),
  /** Working directory of the Supervisor agent (it runs on the daemon). Falls back to FACTORY_DEFAULT_CWD. */
  cwd: z.string().optional(),
  /** "provider/model" used when the role names none. */
  defaultProvider: z.string().default("claude/claude-sonnet-5-5"),
  /** Role file of the Supervisor in the git source. */
  role: z.string().default("supervisor"),
  /** How often the Factory looks for problems to tell the Supervisor about. */
  digestSeconds: z.number().int().min(15).default(60),
  /** An open issue is told again after this long. */
  repeatMinutes: z.number().int().min(5).default(30),
  /** supervisor_ask waits this long for the answer before returning a pending request. */
  askTimeoutSeconds: z.number().int().min(5).max(600).default(120),
});
export type SupervisorSettings = z.output<typeof settingsSchema>;

export const supervisorSettings = defineSettings({ id: "supervisor", scope: "host", version: 1, schema: settingsSchema });
