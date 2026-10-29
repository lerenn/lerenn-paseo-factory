import { z } from "zod";

export const itemStatusSchema = z.enum(["pending", "answered", "expired", "withdrawn", "archived"]);
export type ItemStatus = z.infer<typeof itemStatusSchema>;

export const optionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  /** Shown first, like the recommended choice of a multiple-choice question. */
  recommended: z.boolean().optional(),
});
export type InboxOption = z.infer<typeof optionSchema>;

export const answerSchema = z.object({
  optionId: z.string().nullable(),
  text: z.string().nullable(),
  by: z.enum(["human", "default", "assistant", "pm"]),
  at: z.number(),
});
export type Answer = z.infer<typeof answerSchema>;

export const APPROVAL_OPTIONS: InboxOption[] = [
  { id: "approve", label: "Approve" },
  { id: "deny", label: "Deny" },
];

export const itemViewSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentTitle: z.string().nullable(),
  projectName: z.string().nullable(),
  workspaceName: z.string().nullable(),
  kind: z.enum(["question", "approval"]),
  question: z.string(),
  context: z.string().nullable(),
  options: z.array(optionSchema),
  allowFreeText: z.boolean(),
  blocking: z.boolean(),
  status: itemStatusSchema,
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  defaultOptionId: z.string().nullable(),
  defaultText: z.string().nullable(),
  readAt: z.number().nullable(),
  answer: answerSchema.nullable(),
  comment: z.string().nullable(),
  delivery: z.enum(["pending", "sent", "failed", "undeliverable", "none"]),
  endedAt: z.number().nullable(),
});
export type ItemView = z.infer<typeof itemViewSchema>;

export const eventViewSchema = z.object({
  at: z.number(),
  itemId: z.string(),
  type: z.string(),
  actor: z.string(),
  detail: z.string().nullable(),
});
export type EventView = z.infer<typeof eventViewSchema>;
