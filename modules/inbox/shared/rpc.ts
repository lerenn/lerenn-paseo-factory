import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { eventViewSchema, itemViewSchema } from "./item";
import { settingsSchema } from "./settings";

export const listItemsRpc = defineRpc({
  name: "inbox.list",
  input: z.object({ audit: z.boolean().optional() }),
  output: z.object({
    now: z.number(),
    items: z.array(itemViewSchema),
    events: z.array(eventViewSchema),
    settings: settingsSchema.nullable(),
    settingsError: z.string().nullable(),
    endpoint: z.object({ url: z.string().nullable(), error: z.string().nullable() }),
  }),
});

/** Unread = pending and never opened. Cheap, polled by the sidebar badge. */
export const countRpc = defineRpc({
  name: "inbox.count",
  input: z.object({}),
  output: z.object({ unread: z.number(), pending: z.number() }),
});

export const answerRpc = defineRpc({
  name: "inbox.answer",
  input: z.object({
    itemId: z.string(),
    optionId: z.string().optional(),
    text: z.string().max(10_000).optional(),
    comment: z.string().max(2_000).optional(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string().nullable(), item: itemViewSchema.nullable() }),
});

export const readRpc = defineRpc({
  name: "inbox.read",
  input: z.object({ itemId: z.string() }),
  output: z.object({}),
});
