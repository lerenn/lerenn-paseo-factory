import { McpServer } from "./mcp";
import { adapt, type HostTool } from "./tools";

/** An MCP server over a module's tools, for tests. */
export function mcpFor<E>(engine: E, tools: Parameters<typeof adapt<E>>[0][], instructions = ""): McpServer {
  const host: HostTool[] = tools.map((t) => ({ ...adapt(t, engine), owner: "test" }));
  return new McpServer({ tools: () => host, aliases: () => [], instructions: () => instructions });
}

export const caller = (callerId: string, labels: Record<string, string> = {}) => ({ callerId, labels: async () => labels });

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { factorySettingsSchema } from "../shared/settings";
import { settingsSchema as wardenSettingsSchema } from "../modules/warden/shared/settings";
import { settingsSchema as inboxSettingsSchema } from "../modules/inbox/shared/settings";
import { settingsSchema as leasesSettingsSchema } from "../modules/leases/shared/settings";
import { settingsSchema as blueprintsSettingsSchema } from "../modules/blueprints/shared/settings";
import contribute from "../index.server";

type Handler = (input: any, ctx: any) => any;

/** The whole plugin on a fake server: handlers by name, a fake daemon SDK, a private data folder. */
export function bootPlugin(settings: Record<string, object> = {}, paseoOverrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-"));
  process.env.FACTORY_PORT = "0";
  process.env.FACTORY_DATA = path.join(dir, "data");
  process.env.FACTORY_ENDPOINT = path.join(dir, "endpoint.json");
  const before: Record<string, Handler[]> = {};
  const on: Record<string, Handler[]> = {};
  const rpc: Record<string, Handler> = {};
  const schemas: Record<string, { parse(v: unknown): unknown }> = {
    factory: factorySettingsSchema,
    warden: wardenSettingsSchema,
    inbox: inboxSettingsSchema,
    leases: leasesSettingsSchema,
    blueprints: blueprintsSettingsSchema,
    roles: { parse: (v) => ({ sources: [], ...(v as object) }) },
  };
  const sent: { id: string; text: string }[] = [];
  const paseo: any = {
    workspaces: { list: async () => ({ entries: [{ id: "w", projectDisplayName: "Proj", projectCustomName: null, name: "ws-branch", title: "Nice workspace" }] }) },
    agents: {
      list: async () => ({ entries: [] }),
      ref: (id: string) => ({
        send: async (text: string) => void sent.push({ id, text }),
        refresh: async () => ({ agent: { archivedAt: null, status: "idle" } }),
        timeline: { subscribe: () => () => {}, append: async () => ({}) },
      }),
    },
    ...paseoOverrides,
  };
  const ctx = { paseo, signal: new AbortController().signal };
  const server = {
    registerSettings: (def: { id: string }) => ({
      read: async () => ({ status: "ready", revision: "1", values: schemas[def.id].parse(settings[def.id] ?? {}) }),
      subscribe: () => () => {},
    }),
    before: (name: string, h: Handler) => ((before[name] ??= []).push(h), () => {}),
    on: (name: string, h: Handler) => ((on[name] ??= []).push(h), () => {}),
    handle: (contract: { name: string }, h: Handler) => void (rpc[contract.name] = h),
  };
  const cleanup = contribute(server as never);
  /** Run the before-hooks in order, threading the request like the daemon does. */
  const create = async (request: any) => {
    let current = request;
    let changed = false;
    for (const h of before["agent.create"] ?? []) {
      const out = await h({ request: current }, ctx);
      if (out) {
        current = out;
        changed = true;
      }
    }
    return changed ? current : undefined;
  };
  const fire = async (name: string, event: unknown) => {
    for (const h of on[name] ?? []) await h(event, ctx);
  };
  const open = async (request: any) => {
    for (const h of before["agent.session_open"] ?? []) await h({ request }, ctx);
  };
  return { rpc, ctx, sent, create, fire, open, cleanup, dir, paseo };
}
