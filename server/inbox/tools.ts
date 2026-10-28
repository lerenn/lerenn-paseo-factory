import { z } from "zod";
import { UsageError, type Engine } from "./engine";
import type { Item } from "./store";
import { itemStatusSchema } from "../../shared/inbox/item";

export interface ToolContext {
  engine: Engine;
  /** The calling agent. */
  callerId: string;
  /** Labels of the caller; undefined in tests that do not need them. */
  labels?: () => Promise<Record<string, string>>;
}

/** Agents with this label (the Assistant plugin's) may see and answer every pending item, on the user's behalf. */
export const ASSISTANT_LABEL = "paseo.assistant";

async function isAssistant(ctx: ToolContext): Promise<boolean> {
  return (await ctx.labels?.())?.[ASSISTANT_LABEL] === "1";
}

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodObject;
  run(input: any, ctx: ToolContext): Promise<unknown> | unknown;
}

const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "option";

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
      "Ask the human a multiple-choice question or request an approval, then end your turn. Give 2 to 4 options (label, optional description, optional recommended flag: the recommended one is shown first); " +
      "an open \"Other\" free-text answer is always added as the last choice, so do not add one yourself. Use kind \"approval\" with no options for a plain Approve / Deny. " +
      "The answer arrives later as a message starting with \"Agents Inbox:\". Asking the same question while it is pending returns the same item.",
    input: z.object({
      question: z.string().min(1).max(4000).describe("What you need decided, written for someone who has not read your conversation."),
      kind: z.enum(["question", "approval"]).optional().describe('"approval" offers Approve / Deny. Default "question".'),
      options: z
        .array(
          z.object({
            id: z.string().min(1).max(64).optional().describe("Stable id returned in the answer; defaults to a slug of the label."),
            label: z.string().min(1).max(200),
            description: z.string().max(500).optional(),
            recommended: z.boolean().optional(),
          }),
        )
        .max(4)
        .optional()
        .describe("2 to 4 choices. Required for kind \"question\"."),
      context: z.string().max(20_000).optional().describe("Details the human needs: diff summary, links, what happens on each choice."),
      blocking: z.boolean().optional().describe("Default true: you stop and wait. false: you may carry on and be told later."),
      expires_in_minutes: z.number().min(1).max(60 * 24 * 30).optional(),
      default_answer: z.string().max(10_000).optional().describe("Option id (or text) used if it expires. Needs expires_in_minutes."),
      dedupe_key: z.string().max(200).optional().describe("Stable key to make retries idempotent. Default: derived from the question and options."),
    }),
    run(input, ctx) {
      const kind = input.kind ?? "question";
      const given = input.options ?? [];
      if (kind === "question" && (given.length < 2 || given.length > 4)) {
        throw new UsageError(
          `inbox_ask needs 2 to 4 options (got ${given.length}), like a multiple-choice question: options: [{label, description?, recommended?}, ...]. ` +
            `An open "Other" answer is added for you. For a plain yes/no use kind "approval" without options.`,
        );
      }
      const options = given.map((o: { id?: string; label: string; description?: string; recommended?: boolean }) => ({ id: o.id ?? slug(o.label), label: o.label, ...(o.description ? { description: o.description } : {}), ...(o.recommended ? { recommended: true } : {}) }));
      const { item, deduped } = ctx.engine.ask({
        agentId: ctx.callerId,
        question: input.question,
        kind,
        options,
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
    name: "inbox_pending",
    description:
      "Pending inbox items waiting for the human, across all agents, with their options. Only for agents labelled paseo.assistant=1 (the Assistant plugin); other agents see their own pending items.",
    input: z.object({}),
    async run(_input, ctx) {
      const assistant = await isAssistant(ctx);
      return ctx.engine.store
        .pending()
        .filter((i) => assistant || i.agentId === ctx.callerId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((i) => ({ ...summary(i), asked_by: i.agentId, context: i.context, options: i.options, allow_free_text: i.allowFreeText, created_at: new Date(i.createdAt).toISOString() }));
    },
  },
  {
    name: "inbox_answer",
    description:
      "Answer a pending item on behalf of the user. Only for agents labelled paseo.assistant=1 (the Assistant plugin); the answer is recorded as \"answered by the Assistant on behalf of the user\". " +
      "`answer` is an option id, or free text for items that take it. Answer only what the user said; never decide for him.",
    input: z.object({
      item: z.string().describe("The item id from inbox_pending."),
      answer: z.string().min(1).max(10_000).describe("An option id, or free text."),
      comment: z.string().max(2000).optional(),
    }),
    async run({ item, answer, comment }, ctx) {
      if (!(await isAssistant(ctx))) throw new UsageError("inbox_answer is for the Assistant only (agents labelled paseo.assistant=1).");
      const found = ctx.engine.store.get(item);
      if (!found) throw new UsageError(`No inbox item "${item}".`);
      const isOption = found.options.some((o) => o.id === answer);
      const result = ctx.engine.answer(item, isOption ? { optionId: answer, comment } : { text: answer, comment }, "assistant");
      if (!result.ok) throw new UsageError(result.message ?? "Not answered.");
      return { ...summary(result.item!), recorded_as: "answered by the Assistant on behalf of the user" };
    },
  },
  {
    name: "inbox_withdraw",
    description:
      "Take back one of your pending questions that no longer matters. The Assistant (paseo.assistant=1) may also withdraw the Factory's own items (asker `blueprint:<run>`), such as an escalation of a run that is running again.",
    input: z.object({ item_id: z.string(), reason: z.string().max(500).optional() }),
    async run({ item_id, reason }, ctx) {
      const found = ctx.engine.store.get(item_id);
      const item = found?.agentId.startsWith("blueprint:") && (await isAssistant(ctx)) ? found : own(item_id, ctx);
      ctx.engine.withdraw(item, ctx.callerId, reason ?? null);
      return summary(item);
    },
  },
];
