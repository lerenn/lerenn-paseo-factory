import { z } from "zod";

export const modeSchema = z.enum(["queue", "takeover"]);
export type LeaseMode = z.infer<typeof modeSchema>;

export const LEASE_NAME = /^[\w.:/#@+=-]{1,200}$/;

export const leaseViewSchema = z.object({
  name: z.string(),
  /** Fencing token: goes up on every change of holder. */
  handover: z.number(),
  holder: z
    .object({
      agentId: z.string(),
      agentTitle: z.string().nullable(),
      mode: modeSchema,
      ttlSeconds: z.number(),
      acquiredAt: z.number(),
      expiresAt: z.number(),
    })
    .nullable(),
  queue: z.array(z.object({ agentId: z.string(), agentTitle: z.string().nullable(), ttlSeconds: z.number(), enqueuedAt: z.number() })),
});
export type LeaseView = z.infer<typeof leaseViewSchema>;

export const eventViewSchema = z.object({
  at: z.number(),
  lease: z.string(),
  type: z.string(),
  actor: z.string(),
  detail: z.string().nullable(),
});
export type EventView = z.infer<typeof eventViewSchema>;
