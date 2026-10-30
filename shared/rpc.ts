import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { factorySettingsSchema } from "./settings";

/** What the client shell needs: which modules are on, which extensions add tabs. */
export const overviewRpc = defineRpc({
  name: "factory.overview",
  input: z.object({}),
  output: z.object({
    settings: factorySettingsSchema.nullable(),
    endpoint: z.object({ url: z.string().nullable(), error: z.string().nullable() }),
    extensions: z.array(z.object({ id: z.string(), version: z.string(), tab: z.string().nullable(), tools: z.array(z.string()), stageKinds: z.array(z.string()), health: z.enum(["ok", "degraded"]).default("ok") })),
  }),
});

/** An extension's backend call, served by the Factory: validated against the extension's own schemas. */
export const extensionCallRpc = defineRpc({
  name: "factory.extension.call",
  input: z.object({ id: z.string(), name: z.string(), input: z.unknown().optional() }),
  output: z.object({ ok: z.boolean(), output: z.unknown().optional(), error: z.string().nullable() }),
});

export const activityItemSchema = z.object({
  at: z.number(),
  /** A Factory kind (run, stage, gate, escalation, lease, merge, inbox, extension) or an extension's own label. */
  type: z.string(),
  tone: z.enum(["success", "warning", "danger"]).nullable().default(null),
  title: z.string(),
  detail: z.string().nullable(),
  blueprint: z.string().nullable(),
  role: z.string().nullable(),
  link: z.object({ tab: z.string(), id: z.string() }).nullable(),
});
export type ActivityEntry = z.infer<typeof activityItemSchema>;

/** The factory-wide feed, newest first. */
export const activityRpc = defineRpc({
  name: "factory.activity",
  input: z.object({ limit: z.number().int().min(1).max(500).default(200) }),
  output: z.object({ now: z.number(), items: z.array(activityItemSchema) }),
});

export const transcriptMessageSchema = z.object({ role: z.enum(["user", "assistant", "tool", "error"]), text: z.string(), at: z.string().nullable() });
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;

/** The latest messages of an agent, read-only. */
export const transcriptRpc = defineRpc({
  name: "factory.transcript",
  input: z.object({ agentId: z.string(), limit: z.number().int().min(1).max(40).default(8) }),
  output: z.object({ ok: z.boolean(), messages: z.array(transcriptMessageSchema), error: z.string().nullable() }),
});
