import { z } from "zod";

export const taskStatusSchema = z.enum([
  "ok",
  "pinged",
  "escalated",
  "waiting-permission",
  "gave-up",
  "done",
  "expired",
  "archived",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskViewSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentTitle: z.string().nullable(),
  parentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  projectName: z.string().nullable(),
  workspaceName: z.string().nullable(),
  task: z.string(),
  /** The hang backstop in effect (the registered interval, clamped to the max setting). */
  intervalMinutes: z.number(),
  turn: z.enum(["running", "idle", "waiting-permission", "unknown"]),
  idleSince: z.number().nullable(),
  until: z.number().nullable(),
  registeredBy: z.string(),
  source: z.enum(["agent", "parent", "announced-work", "user"]),
  status: taskStatusSchema,
  createdAt: z.number(),
  lastActivityAt: z.number(),
  lastPingAt: z.number().nullable(),
  pings: z.number(),
  unanswered: z.number(),
  notes: z.array(z.object({ at: z.number(), text: z.string() })),
  result: z.string().nullable(),
  /** Live subagents of this agent, and how many of them need it right now. */
  children: z.number(),
  needAttention: z.number(),
  /** When the next ping fires and why; null when none is scheduled. */
  nextPing: z.object({ at: z.number(), reason: z.string() }).nullable(),
  waitingOn: z.string().nullable(),
});
export type TaskView = z.infer<typeof taskViewSchema>;
