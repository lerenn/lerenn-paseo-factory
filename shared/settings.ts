import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** A role setting: empty or blank is unset and gives the default, so no agent is spawned or shown with an empty role. */
export const roleSetting = (fallback: string) =>
  z
    .string()
    .transform((v) => v.trim() || fallback)
    .default(fallback);

/** The runtime that needs no plugin: the agent runs on the daemon. */
export const LOCAL_RUNTIME = "local";

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
  /**
   * Runtime of every workspace the Factory creates (Supervisor, PMs, stage workers): `local` runs the agent on the daemon,
   * any other value is the id of a workspace runtime plugin (`runtime.id` of `workspaces.create`), for example `kubernetes`
   * for the Kubernetes Runtime.
   */
  runtime: z.string().trim().min(1).default(LOCAL_RUNTIME),
  /**
   * Projects the Factory stays out of: it never lists, watches, digests or spawns an agent whose directory is inside one
   * (matched by path, so an agent recreated with a new id stays excluded). Empty: none.
   */
  excludePaths: z.array(z.string()).default([]),
  /** Extra agent ids to leave alone. */
  excludeAgents: z.array(z.string()).default([]),
  /**
   * Labels ("key=value") that mark a trusted agent, such as an assistant acting for the user: it may see and answer every
   * inbox item, withdraw the Factory's own items, steer any run and use whole-Factory operations. Its workspace is never swept.
   * Empty: no agent is trusted this way.
   */
  trustedLabels: z.array(z.string()).default([]),
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
