import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { settingsSchema } from "./settings";

export const supervisorRequestSchema = z.object({
  id: z.string(),
  fromId: z.string(),
  fromName: z.string(),
  question: z.string(),
  at: z.number(),
  answer: z.string().nullable(),
  answeredAt: z.number().nullable(),
});
export type SupervisorRequest = z.infer<typeof supervisorRequestSchema>;

export const supervisorStatusSchema = z.object({
  /** The stable agent id to steer it by. */
  agentId: z.string().nullable(),
  state: z.enum(["running", "idle", "stopped", "not-started", "error"]),
  error: z.string().nullable(),
  startedAt: z.number().nullable(),
  issues: z.array(z.object({ key: z.string(), text: z.string() })),
  lastDigestAt: z.number().nullable(),
  restarts: z.array(z.object({ extension: z.string(), at: z.number() })),
  requests: z.array(supervisorRequestSchema),
});
export type SupervisorStatus = z.infer<typeof supervisorStatusSchema>;

export const supervisorStatusRpc = defineRpc({
  name: "supervisor.status",
  input: z.object({}),
  output: z.object({ status: supervisorStatusSchema, settings: settingsSchema.nullable() }),
});

export const supervisorStartRpc = defineRpc({
  name: "supervisor.start",
  input: z.object({ restart: z.boolean().default(false) }),
  output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
});

/** the user writes to the Supervisor from its tab. */
export const supervisorSendRpc = defineRpc({
  name: "supervisor.send",
  input: z.object({ text: z.string().min(1).max(4000) }),
  output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
});
