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
    extensions: z.array(z.object({ id: z.string(), version: z.string(), tab: z.string().nullable(), tools: z.array(z.string()), stageKinds: z.array(z.string()) })),
  }),
});
