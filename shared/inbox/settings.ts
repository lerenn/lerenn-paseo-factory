import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_ANSWER_TEMPLATE =
  "Agents Inbox: your question \"{{question}}\" (item {{id}}) was answered{{by}}: {{answer}}{{comment}}";
export const DEFAULT_EXPIRED_TEMPLATE =
  "Agents Inbox: your question \"{{question}}\" (item {{id}}) expired without an answer. Decide what to do without it, or ask again.";

export const settingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** "all": every new agent except those created with PASEO_INBOX=off. "opt-in": only PASEO_INBOX=on. */
  scope: z.enum(["all", "opt-in"]).default("all"),
  tickSeconds: z.number().int().min(5).default(30),
  /** Never send more than one inbox message within this window, across all agents. */
  globalGapSeconds: z.number().int().min(0).default(3),
  /** Delivery attempts for an answer before giving up (the answer stays recorded). */
  maxDeliveryAttempts: z.number().int().min(1).default(8),
  /** Default expiry for items that do not set one; 0 means never. */
  defaultExpiryMinutes: z.number().int().min(0).default(0),
  /** Mail one short notice per new item (any asker) to this address, for example "@assistant". Empty: off. Items the Factory opens for a blueprint gate are skipped while the blueprints events.mailTo is set (its gate mail already covers them). */
  notifyMailTo: z.string().default(""),
  retentionDays: z.number().int().min(1).default(30),
  answerTemplate: z.string().default(DEFAULT_ANSWER_TEMPLATE),
  expiredTemplate: z.string().default(DEFAULT_EXPIRED_TEMPLATE),
});
export type InboxSettings = z.output<typeof settingsSchema>;

export const inboxSettings = defineSettings({
  id: "inbox",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
