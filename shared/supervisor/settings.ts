import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsSchema = z.object({
  /** Off: the Supervisor is never started or woken (no agent, no digests, no restarts by it); supervisor_ask answers that it is disabled, and expired leases and dropped extensions are mailed to the blueprints events.mailTo (else reportTo) instead. An agent that is already running is archived at the next digest tick. */
  enabled: z.boolean().default(true),
  /** Wake the Supervisor on its own triggers (a run starts, a digest with new problems, an extension crash). Off: only asks, chat and "Wake now" wake it. */
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
  /** The Supervisor is archived after this many minutes with the Factory idle (and recreated on demand). 0 keeps it always on. */
  idleArchiveMinutes: z.number().int().min(0).default(10),
  /** supervisor_ask waits this long for the answer before returning a pending request. */
  askTimeoutSeconds: z.number().int().min(5).max(600).default(120),
  /** Address or alias (e.g. "@ops") that gets the Supervisor's flags, and the Factory notices while it is disabled and the Blueprints module is off. Empty: no mail. */
  reportTo: z.string().default(""),
});
export type SupervisorSettings = z.output<typeof settingsSchema>;

export const supervisorSettings = defineSettings({ id: "supervisor", scope: "host", version: 1, schema: settingsSchema });
