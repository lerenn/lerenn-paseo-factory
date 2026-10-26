import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const MODULES = ["roles", "blueprints", "leases", "warden", "inbox", "supervisor"] as const;
export type ModuleId = (typeof MODULES)[number];

export const factorySettingsSchema = z.object({
  /** Each module is a tab; switched off, it loses its tab, hooks and MCP tools. */
  modules: z
    .object({
      roles: z.boolean().default(true),
      blueprints: z.boolean().default(true),
      leases: z.boolean().default(true),
      warden: z.boolean().default(true),
      inbox: z.boolean().default(true),
      supervisor: z.boolean().default(true),
    })
    .default({ roles: true, blueprints: true, leases: true, warden: true, inbox: true, supervisor: true }),
  /** Where every workspace the Factory creates (Supervisor, PMs, stage workers) runs: a pod, or the daemon. */
  runtime: z.enum(["kubernetes", "local"]).default("kubernetes"),
  /**
   * One-off, off by default: on the next start, a module with no Factory state yet copies the state
   * file of its old stand-alone plugin (agents-leases, agents-warden, agents-inbox).
   */
  importLegacyState: z.boolean().default(false),
});
export type FactorySettings = z.output<typeof factorySettingsSchema>;

export const factorySettings = defineSettings({
  id: "factory",
  scope: "host",
  version: 1,
  schema: factorySettingsSchema,
});
