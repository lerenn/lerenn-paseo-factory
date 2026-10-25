import { z } from "zod";
import { UsageError, type Engine } from "./engine";
import type { Item } from "./store";
import { itemStatusSchema } from "../shared/item";

export interface ToolContext {
  engine: Engine;
  /** The calling agent. */
  callerId: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodObject;
  run(input: any, ctx: ToolContext): Promise<unknown> | unknown;
}

function summary(item: Item) {
  return {
    item_id: item.id,
    status: item.status,
    kind: item.kind,
    question: item.question,
    ...(item.answer ? { answer: { option_id: item.answer.optionId, text: item.answer.text, by: item.answer.by }, comment: item.comment } : {}),
  };
}

/** Only the asker sees and manages its items. */
function own(itemId: string, ctx: ToolContext): Item {
  const item = ctx.engine.store.get(itemId);
  if (!item || item.agentId !== ctx.callerId) throw new UsageError(`No inbox item "${itemId}" of yours. Use inbox_list to see yours.`);
  return item;
}

export const TOOLS: ToolDef[] = [
  {
    name: "inbox_ask",
    description:
      "Ask the human a question or request an approval, then end your turn. The answer arrives later as a message starting with \"Agents Inbox:\". Asking the same question while it is pending returns the same item.",
    input: z.object({
      question: z.string().min(1).max(4000).describe("What you need decided, written for someone who has not read your conversation."),
      kind: z.enum(["question", "approval"]).optional().describe('"approval" offers approve / deny. Default "question".'),
      options: z
        .array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(200) }))
        .max(12)
        .optional()
        .describe("Answers to pick from. Omit for a free-text answer."),
      allow_free_text: z.boolean().optional().describe("Also accept free text when options are given. Default: only without options."),
      context: z.string().max(20_000).optional().describe("Details the human needs: diff summary, links, what happens on each choice."),
      blocking: z.boolean().optional().describe("Default true: you stop and wait. false: you may carry on and be told later."),
      expires_in_minutes: z.number().min(1).max(60 * 24 * 30).optional(),
      default_answer: z.string().max(10_000).optional().describe("Option id (or text for free-text items) used if it expires. Needs expires_in_minutes."),
      dedupe_key: z.string().max(200).optional().describe("Stable key to make retries idempotent. Default: derived from the question and options."),
    }),
    run(input, ctx) {
      const { item, deduped } = ctx.engine.ask({
        agentId: ctx.callerId,
        question: input.question,
        kind: input.kind,
        options: input.options,
        allowFreeText: input.allow_free_text,
        context: input.context,
        blocking: input.blocking,
        expiresInMinutes: input.expires_in_minutes,
        defaultAnswer: input.default_answer,
        dedupeKey: input.dedupe_key,
      });
      const next = item.blocking
        ? "End your turn now. The answer will arrive as a message starting with \"Agents Inbox:\"."
        : "You may carry on. The answer will arrive later as a message starting with \"Agents Inbox:\".";
      return { ...summary(item), deduped, next };
    },
  },
  {
    name: "inbox_status",
    description: "The state and answer of one of your inbox items.",
    input: z.object({ item_id: z.string() }),
    run: ({ item_id }, ctx) => summary(own(item_id, ctx)),
  },
  {
    name: "inbox_list",
    description: "Your inbox items, newest first.",
    input: z.object({ status: itemStatusSchema.optional() }),
    run: ({ status }, ctx) =>
      ctx.engine.store
        .all()
        .filter((i) => i.agentId === ctx.callerId && (!status || i.status === status))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(summary),
  },
  {
    name: "inbox_withdraw",
    description: "Take back one of your pending questions that no longer matters.",
    input: z.object({ item_id: z.string(), reason: z.string().max(500).optional() }),
    run({ item_id, reason }, ctx) {
      const item = own(item_id, ctx);
      ctx.engine.withdraw(item, ctx.callerId, reason ?? null);
      return summary(item);
    },
  },
];
