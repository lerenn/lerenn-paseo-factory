import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_GRANTED_TEMPLATE =
  "Agents Leases: you now hold lease \"{{name}}\" (token {{token}}, valid {{ttl}} s). Renew it with lease_renew before it expires and release it with lease_release when you are done.";
export const DEFAULT_LOST_TEMPLATE =
  "Agents Leases: you lost lease \"{{name}}\" ({{reason}}). Your token {{token}} is no longer valid: stop working on that resource now.";

/** A lease that lapsed with nobody waiting: its last holder may take it again (nobody else has it). */
export const DEFAULT_EXPIRED_TEMPLATE =
  "Agents Leases: your lease \"{{name}}\" expired (it was not renewed in time) and nobody else holds it. Token {{token}} is no longer valid. If the work is still yours, take it again with lease_acquire (mode queue) and carry on; if that queues you, someone else has it: leave the queue with lease_release and stop.";

export const settingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** "all": every new agent except those created with PASEO_LEASES=off. "opt-in": only PASEO_LEASES=on. */
  scope: z.enum(["all", "opt-in"]).default("all"),
  tickSeconds: z.number().int().min(1).default(10),
  /** Longest TTL an agent may ask for. */
  maxTtlSeconds: z.number().int().min(10).default(7 * 24 * 3600),
  /** Delivery attempts for a message before giving up (the state change stays recorded). */
  maxDeliveryAttempts: z.number().int().min(1).default(8),
  /** Idle free leases and audit entries are removed after this many days. */
  retentionDays: z.number().int().min(1).default(30),
  grantedTemplate: z.string().default(DEFAULT_GRANTED_TEMPLATE),
  lostTemplate: z.string().default(DEFAULT_LOST_TEMPLATE),
  expiredTemplate: z.string().default(DEFAULT_EXPIRED_TEMPLATE),
});
export type LeasesSettings = z.output<typeof settingsSchema>;

export const leasesSettings = defineSettings({
  id: "leases",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
