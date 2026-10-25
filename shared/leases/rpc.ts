import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { eventViewSchema, leaseViewSchema } from "./lease";
import { settingsSchema } from "./settings";

export const listLeasesRpc = defineRpc({
  name: "leases.list",
  input: z.object({ audit: z.boolean().optional() }),
  output: z.object({
    now: z.number(),
    leases: z.array(leaseViewSchema),
    events: z.array(eventViewSchema),
    settings: settingsSchema.nullable(),
    settingsError: z.string().nullable(),
    endpoint: z.object({ url: z.string().nullable(), error: z.string().nullable() }),
  }),
});

/** Held leases and waiting agents. Cheap, polled by the sidebar badge. */
export const countRpc = defineRpc({
  name: "leases.count",
  input: z.object({}),
  output: z.object({ held: z.number(), waiting: z.number() }),
});

export const forceReleaseRpc = defineRpc({
  name: "leases.force-release",
  input: z.object({ name: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
});
