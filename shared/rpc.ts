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
